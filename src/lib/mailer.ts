import nodemailer from "nodemailer";
import { prisma } from "./prisma";
import { decrypt } from "./crypto";

export type SmtpConfig = { host: string; port: number; user: string; pass: string; fromEmail: string };
type MailInput = { to: string; subject: string; html: string };

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

async function getSmtp(): Promise<{ config: SmtpConfig; storeName: string } | null> {
  const row = await prisma.storeConfig.findUnique({ where: { id: "store-config-singleton" }, select: { emailConfig: true, storeName: true } });
  const raw = row?.emailConfig as { encrypted?: string } | null;
  if (!raw?.encrypted) return null;
  const config = decrypt<SmtpConfig>(raw.encrypted);
  if (!config || !config.host || !config.fromEmail) return null;
  return { config, storeName: row?.storeName ?? "Store" };
}

export async function sendMail(input: MailInput): Promise<void> {
  const setup = await getSmtp();
  if (!setup) throw new Error("SMTP is not configured");
  const { config } = setup;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port || 587,
    secure: Number(config.port) === 465,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  await transporter.sendMail({ from: `"${setup.storeName}" <${config.fromEmail}>`, to: input.to, subject: input.subject, html: input.html });
}

export function sendNewsletterWelcome(email: string): Promise<void> {
  return getSmtp().then((setup) => {
    if (!setup) return;
    return sendMail({
      to: email,
      subject: `Welcome to ${setup.storeName}!`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#111827;margin:0 0 12px">Welcome to ${escapeHtml(setup.storeName)} 🎉</h2>
          <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">You have subscribed to our newsletter. You will be the first to hear about new drops, restocks and exclusive offers.</p>
          <p style="color:#6B7280;font-size:13px;line-height:1.6;margin:0">No spam — one-click unsubscribe anytime.</p>
        </div>`,
    });
  });
}

export async function sendOrderConfirmation(order: {
  orderId: string;
  customerEmail: string;
  customerName: string;
  items: { name: string; qty: number; price: number }[];
  subtotal: number;
  shippingCharge: number;
  discountAmount: number;
  totalAmount: number;
  paymentMethod: string;
}): Promise<void> {
  const setup = await getSmtp();
  if (!setup) return;
  const money = (v: number) => "৳ " + Number(v).toLocaleString("en-BD");
  const rows = order.items
    .map(
      (i) => `
        <tr>
          <td style="padding:8px 0;color:#111827">${escapeHtml(i.name)} × ${i.qty}</td>
          <td style="padding:8px 0;text-align:right;color:#111827">${money(i.price * i.qty)}</td>
        </tr>`
    )
    .join("");
  await sendMail({
    to: order.customerEmail,
    subject: `Order #${order.orderId.slice(0, 8).toUpperCase()} confirmed — ${setup.storeName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#111827;margin:0 0 8px">Hi ${escapeHtml(order.customerName || "there")},</h2>
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 20px">Thank you for your order at <strong>${escapeHtml(setup.storeName)}</strong>! Order <strong>#${escapeHtml(order.orderId.slice(0, 8).toUpperCase())}</strong> is confirmed. 😊</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          ${rows}
        </table>
        <div style="border-top:1px solid #E5E7EB;margin-top:8px;padding-top:10px;font-size:14px">
          <div style="display:flex;justify-content:space-between"><span style="color:#6B7280">Subtotal</span><strong>${money(order.subtotal)}</strong></div>
          ${order.discountAmount > 0 ? `<div style="display:flex;justify-content:space-between"><span style="color:#6B7280">Discount</span><strong style="color:#059669">- ${money(order.discountAmount)}</strong></div>` : ""}
          <div style="display:flex;justify-content:space-between"><span style="color:#6B7280">Shipping</span><strong>${money(order.shippingCharge)}</strong></div>
          <div style="display:flex;justify-content:space-between;font-size:16px;margin-top:6px"><span>Total</span><strong>${money(order.totalAmount)}</strong></div>
        </div>
        <p style="color:#6B7280;font-size:13px;margin:20px 0 0">Payment: ${escapeHtml(order.paymentMethod)} · We will contact you shortly for delivery details.</p>
      </div>`,
  });
}

export async function sendOrderStatusEmail(order: {
  orderId: string;
  customerEmail: string;
  customerName: string;
  status: string;
}): Promise<void> {
  const setup = await getSmtp();
  if (!setup) return;
  await sendMail({
    to: order.customerEmail,
    subject: `Update on order #${order.orderId.slice(0, 8).toUpperCase()} — ${escapeHtml(order.status)}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#111827;margin:0 0 8px">Hi ${escapeHtml(order.customerName || "there")},</h2>
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 20px">Your order <strong>#${escapeHtml(order.orderId.slice(0, 8).toUpperCase())}</strong> at <strong>${escapeHtml(setup.storeName)}</strong> has a new update:</p>
        <div style="background:#EEF2FF;border:1px solid #C7D2FE;border-radius:14px;padding:18px 22px;text-align:center;margin-bottom:20px">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6366F1;margin-bottom:6px">Order Status</div>
          <div style="font-size:20px;font-weight:800;color:#4338CA">${escapeHtml(order.status)}</div>
        </div>
        <p style="color:#6B7280;font-size:13px;line-height:1.6;margin:0">You can track the full journey of your order anytime from your profile. Thank you for shopping with us!</p>
      </div>`,
  });
}

export async function sendTestMail(to: string): Promise<void> {
  const setup = await getSmtp();
  if (!setup) {
    throw new Error("SMTP is not configured. Save Email SMTP settings first.");
  }
  await sendMail({
    to,
    subject: "Test email from " + setup.storeName + " ✅",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#111827;margin:0 0 8px">SMTP connection works! 🎉</h2>
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0">This email was sent from <strong>${escapeHtml(setup.storeName)}</strong> using your SMTP settings (<em>${escapeHtml(setup.config.host)}</em>).</p>
      </div>`,
  });
}