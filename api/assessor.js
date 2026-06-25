import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@notionhq/client";
import { google } from "googleapis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DB_ID = "7bf15fdd-1e34-4d2d-9511-127da0c71081";
const CALENDAR_ID = "ronaldomuller526@gmail.com";

const serviceAccount = {
  type: "service_account",
  project_id: process.env.GC_PROJECT_ID,
  private_key_id: process.env.GC_PRIVATE_KEY_ID,
  private_key: process.env.GC_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  client_email: process.env.GC_CLIENT_EMAIL,
  client_id: process.env.GC_CLIENT_ID,
  token_uri: "https://oauth2.googleapis.com/token",
};

async function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

async function extractEventFromClaude(userMessage) {
  const today = new Date().toLocaleDateString("pt-BR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Sao_Paulo",
  });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: `Você é o assessor pessoal executivo de Ronaldo Müller, empresário de Goiânia-GO. 
Hoje é ${today}. Fuso horário: America/Sao_Paulo (GMT-3).

Seu papel é extrair intenções de agendamento da fala do Ronaldo e retornar um JSON estruturado.

SEMPRE retorne APENAS JSON válido, sem texto adicional, sem markdown, sem explicações.

Se for uma solicitação de agendamento, retorne:
{
  "acao": "agendar",
  "titulo": "título do compromisso",
  "data": "YYYY-MM-DD",
  "horario_inicio": "HH:MM",
  "horario_fim": "HH:MM",
  "duracao_minutos": 60,
  "tipo": "Reunião|Pessoal|Financeiro|Bloqueio|MBR",
  "descricao": "detalhes adicionais se houver",
  "confirmacao": "mensagem curta confirmando o agendamento para o Ronaldo"
}

Se NÃO for agendamento, retorne:
{
  "acao": "conversa",
  "resposta": "sua resposta como assessor pessoal do Ronaldo"
}

Regras:
- Se hora não mencionada, use 09:00 como padrão
- Se duração não mencionada, use 60 minutos
- Interprete datas relativas: amanhã, sexta, semana que vem, etc.
- O campo tipo deve ser exatamente um de: Reunião, Pessoal, Financeiro, Bloqueio, MBR
- Seja objetivo e direto, como um assessor executivo`,
    messages: [{ role: "user", content: userMessage }],
  });

  let text = response.content[0].text.trim();
  text = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(text);
}

async function criarNoNotion(evento) {
  const dataISO = evento.data;
  const dataHoraInicio = `${dataISO}T${evento.horario_inicio}:00.000-03:00`;
  const dataHoraFim = `${dataISO}T${evento.horario_fim}:00.000-03:00`;

  await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: {
      Título: {
        title: [{ text: { content: evento.titulo } }],
      },
      Data: {
        date: { start: dataHoraInicio, end: dataHoraFim },
      },
      Horário: {
        rich_text: [{ text: { content: `${evento.horario_inicio} - ${evento.horario_fim}` } }],
      },
      Duração: {
        rich_text: [{ text: { content: `${evento.duracao_minutos} minutos` } }],
      },
      Tipo: {
        select: { name: evento.tipo },
      },
      Descrição: {
        rich_text: [{ text: { content: evento.descricao || "" } }],
      },
      Status: {
        select: { name: "Confirmado" },
      },
    },
  });
}

async function criarNoGoogleCalendar(evento) {
  const calendar = await getCalendarClient();
  const dataHoraInicio = `${evento.data}T${evento.horario_inicio}:00`;
  const dataHoraFim = `${evento.data}T${evento.horario_fim}:00`;

  await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: evento.titulo,
      description: evento.descricao || "",
      start: { dateTime: dataHoraInicio, timeZone: "America/Sao_Paulo" },
      end: { dateTime: dataHoraFim, timeZone: "America/Sao_Paulo" },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 60 },
          { method: "popup", minutes: 15 },
        ],
      },
    },
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Aceita mensagem via GET (?mensagem=...) ou POST body JSON
    const mensagem = req.query?.mensagem || req.body?.mensagem;

    if (!mensagem) {
      return res.status(400).json({ erro: "Campo 'mensagem' é obrigatório" });
    }

    const resultado = await extractEventFromClaude(mensagem);

    if (resultado.acao === "agendar") {
      if (!resultado.horario_fim) {
        const [h, m] = resultado.horario_inicio.split(":").map(Number);
        const totalMin = h * 60 + m + (resultado.duracao_minutos || 60);
        const hFim = Math.floor(totalMin / 60).toString().padStart(2, "0");
        const mFim = (totalMin % 60).toString().padStart(2, "0");
        resultado.horario_fim = `${hFim}:${mFim}`;
      }

      await Promise.all([
        criarNoNotion(resultado),
        criarNoGoogleCalendar(resultado),
      ]);

      return res.status(200).json({
        sucesso: true,
        acao: "agendar",
        resposta: resultado.confirmacao,
        evento: {
          titulo: resultado.titulo,
          data: resultado.data,
          horario: `${resultado.horario_inicio} - ${resultado.horario_fim}`,
          tipo: resultado.tipo,
        },
      });
    } else {
      return res.status(200).json({
        sucesso: true,
        acao: "conversa",
        resposta: resultado.resposta,
      });
    }
  } catch (error) {
    console.error("Erro:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message,
    });
  }
}
