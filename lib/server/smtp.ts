import "server-only";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createConnection, type Socket } from "node:net";

/* A deliberately tiny SMTP client — the npm mailers can't be installed in
 * this project's build environment, and sending one authenticated message
 * needs only six verbs of the protocol. Implicit TLS (port 465, what Gmail's
 * app passwords use); SMTP_SECURE=0 falls back to plaintext for local tests.
 *
 * Configuration (environment):
 *   SMTP_USER  the sending account (e.g. the factory's Gmail address)
 *   SMTP_PASS  its app password (Google account → Security → App passwords)
 *   SMTP_HOST  default smtp.gmail.com     SMTP_PORT  default 465
 *   REPORT_EMAIL_TO  recipient(s), comma-separated — defaults to SMTP_USER
 */

export interface MailResult {
  ok: boolean;
  skipped?: boolean; // SMTP not configured — not an error, just not set up yet
  error?: string;
}

const CRLF = "\r\n";

function smtpExchange(socket: TLSSocket | Socket, commands: { send: string | null; expect: number }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let step = 0;
    const fail = (msg: string) => {
      socket.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("SMTP timeout"), 30000);

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // a reply is complete when its LAST line is "NNN " (space, not dash)
      const lines = buffer.split(CRLF).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      buffer = "";
      const current = commands[step];
      if (code !== current.expect) {
        clearTimeout(timer);
        return fail(`SMTP step ${step + 1}: expected ${current.expect}, got "${last.slice(0, 120)}"`);
      }
      step++;
      if (step >= commands.length) {
        clearTimeout(timer);
        socket.end();
        return resolve();
      }
      // a null send means "wait for the server to speak first" (only step 0)
      const next = commands[step];
      if (next.send !== null) socket.write(next.send + CRLF);
    });
    socket.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    // greeting arrives unprompted; everything after is send→reply
  });
}

/** Send one HTML email. Resolves {skipped:true} when SMTP isn't configured. */
export async function sendMail(subject: string, html: string): Promise<MailResult> {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return { ok: false, skipped: true };

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE !== "0";
  const to = (process.env.REPORT_EMAIL_TO || user).split(",").map((s) => s.trim()).filter(Boolean);

  const message = [
    `From: ATC Production <${user}>`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    // dot-stuffing: a body line starting with "." would end DATA early
    html.replace(/\r?\n/g, CRLF).replace(/(^|\r\n)\./g, "$1.."),
    ".",
  ].join(CRLF);

  const commands = [
    { send: null, expect: 220 }, // server greeting
    { send: `EHLO atc-prod-planner`, expect: 250 },
    { send: `AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`).toString("base64")}`, expect: 235 },
    { send: `MAIL FROM:<${user}>`, expect: 250 },
    ...to.map((rcpt) => ({ send: `RCPT TO:<${rcpt}>`, expect: 250 })),
    { send: "DATA", expect: 354 },
    { send: message, expect: 250 },
    { send: "QUIT", expect: 221 },
  ];

  try {
    const socket = secure
      ? tlsConnect({ host, port, servername: host })
      : createConnection({ host, port });
    await new Promise<void>((res, rej) => {
      socket.once(secure ? "secureConnect" : "connect", res);
      socket.once("error", rej);
    });
    await smtpExchange(socket, commands);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
