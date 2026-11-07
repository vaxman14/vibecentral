// Resend transactional email. One POST per alert; this is the only outbound write the sync function does.
export interface EmailInput {
  apiKey: string;
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(input: EmailInput, signal?: AbortSignal): Promise<{ id: string }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: input.from, to: Array.isArray(input.to) ? input.to : [input.to], subject: input.subject, html: input.html, text: input.text }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* keep raw */ }
    throw new Error(`Resend ${res.status}: ${msg}`);
  }
  try { return JSON.parse(text) as { id: string }; } catch { return { id: '' }; }
}
