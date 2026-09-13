import nodemailer from "nodemailer";
import { prisma } from "./prisma";
import { decrypt } from "./crypto";

export type SmtpConfig = { host: string; port: number; user: string; pass: string; fromEmail: string };

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const money = (value: number | string) => "৳ " + (Number(value) || 0).toLocaleString("en-BD");

type Brand = { storeName: string; primary: string; primaryDark: string; primaryLight: string; fromEmail: string };

function shade(hex: string, amt: number): string {
  const c = hex.replace("#", "");
  const num = parseInt(c, 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amt));
  const b = Math.min(255, Math.max(0, (num & 0xff) + amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

async function getBrand(): Promise<Brand | null> {
  const row = await prisma.storeConfig.findUnique({
    where: { id: "store-config-singleton" },
    select: { emailConfig: true, storeName: true, themeSettings: true },
  });
  const raw = row?.emailConfig as { encrypted?: string } | null;
  if (!raw?.encrypted) return null;
  const config = decrypt<SmtpConfig>(raw.encrypted);
  if (!config || !config.host || !config.fromEmail || !row) return null;
  const settings = row.themeSettings as { primaryColor?: string } | null;
  const primary = /^#[0-9a-fA-F]{6}$/.test(settings?.primaryColor ?? "") ? settings!.primaryColor! : "#4f46e5";
  return { storeName: row?.storeName ?? "Store", primary, primaryDark: shade(primary, -24), primaryLight: shade(primary, 170), fromEmail: config.fromEmail };
}

function layout(brand: Brand, contentHtml: string, footerExtra = ""): string {
  const initial = escapeHtml((brand.storeName || "S").charAt(0).toUpperCase());
  return `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(brand.storeName)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="background-color:#f3f4f6;padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center">
          <div style="max-width:600px;width:100%;background-color:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,.08);">
            <div style="background:linear-gradient(135deg,${brand.primary} 0%,${brand.primaryDark} 100%);padding:34px 40px 30px;text-align:center;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="width:52px;height:52px;border-radius:14px;background:rgba(255,255,255,.18);text-align:center;vertical-align:middle;font-size:24px;font-weight:800;color:#ffffff;">
                          ${initial}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <div style="margin-top:14px;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:.2px;">${escapeHtml(brand.storeName)}</div>
            </div>
            <div style="padding:36px 40px 12px;">
              ${contentHtml}
            </div>
            <div style="border-top:1px solid #eef0f3;padding:22px 40px;text-align:center;background-color:#fafbfc;">
              <div style="font-size:13px;color:#64748b;line-height:1.7;">
                ${escapeHtml(brand.storeName)} · Thank you for shopping with us<br/>
                ${footerExtra}
              </div>
              <div style="margin-top:10px;font-size:11px;color:#94a3b8;">This is an automated message. Please do not reply.</div>
            </div>
          </div>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

function heroCard(titleHtml: string, subHtml: string, tint: string) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="border-radius:18px;background-color:${tint};padding:26px 20px;">
          <div style="font-size:20px;font-weight:800;color:#111827;letter-spacing:.3px;">${titleHtml}</div>
          <div style="margin-top:8px;font-size:14px;color:#475569;line-height:1.6;">${subHtml}</div>
        </td>
      </tr>
    </table>`;
}

function priceRows(rows: { label: string; value: string; muted?: boolean }[]) {
  return rows
    .map(
      (r) => `
      <tr>
        <td style="padding:7px 0;color:${r.muted ? "#94a3b8" : "#64748b"};font-size:14px;">${r.label}</td>
        <td align="right" style="padding:7px 0;font-size:14px;color:${r.muted ? "#94a3b8" : "#111827"};font-weight:700;">${r.value}</td>
      </tr>`
    )
    .join("");
}

function orderBox(orderId: string, detailsBlock: string) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;">
      <tr>
        <td align="center">
          <div style="display:inline-block;font-size:12px;color:#94a3b8;letter-spacing:1.5px;text-transform:uppercase;">Order number</div>
          <div style="font-family:Menlo,Consolas,monospace;font-size:17px;font-weight:800;color:#111827;margin-top:4px;">#${orderId}</div>
        </td>
      </tr>
      <tr><td style="height:20px;">&nbsp;</td></tr>
      ${detailsBlock}
    </table>`;
}

/* ==================== STATUS ==================== */

export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  IN_COURIER: "In Courier",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export const ORDER_STATUS_MESSAGES: Record<string, string> = {
  PENDING: "Great news — we received your order! It is now pending confirmation and our team will reach out soon.",
  CONFIRMED: "Your order is confirmed! Our team has verified it and we are preparing everything for you.",
  IN_COURIER: "Your order has been handed over to the courier. It is now on the way to you!",
  SHIPPED: "Your order is out for delivery. Get ready, it will arrive very soon!",
  DELIVERED: "Your order has been delivered. We hope you love it — thank you for shopping with us!",
  CANCELLED: "Your order has been cancelled. Refunds (if any) are processed within a few days.",
};

const JOURNEY = ["PENDING", "CONFIRMED", "IN_COURIER", "SHIPPED", "DELIVERED"];

function journey(st: string, primary: string) {
  const idx = JOURNEY.indexOf(st);
  const steps = JOURNEY.map((s, i) => (i <= idx ? primary : "#e2e8f0"));
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 6px;">
      <tr>
        <td width="20%" style="padding-right:3px;height:6px;border-radius:3px;background-color:${steps[0]};"></td>
        <td width="20%" style="padding:0 3px;height:6px;border-radius:3px;background-color:${steps[1]};"></td>
        <td width="20%" style="padding:0 3px;height:6px;border-radius:3px;background-color:${steps[2]};"></td>
        <td width="20%" style="padding:0 3px;height:6px;border-radius:3px;background-color:${steps[3]};"></td>
        <td width="20%" style="padding-left:3px;height:6px;border-radius:3px;background-color:${steps[4]};"></td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">
      <tr>
        ${JOURNEY.map((s, i) => `<td align="center" width="20%" style="font-size:9px;letter-spacing:.4px;color:${i <= idx ? "#334155" : "#cbd5e1"};text-transform:uppercase;font-weight:${i <= idx ? "700" : "500"};">${ORDER_STATUS_LABELS[s] ?? s}</td>`).join("")}
      </tr>
    </table>`;
}

/* ==================== MAILERS ==================== */

async function deliver(to: string, subject: string, html: string): Promise<void> {
  const row = await prisma.storeConfig.findUnique({ where: { id: "store-config-singleton" }, select: { emailConfig: true, storeName: true } });
  const raw = row?.emailConfig as { encrypted?: string } | null;
  if (!raw?.encrypted) throw new Error("SMTP is not configured");
  const config = decrypt<SmtpConfig>(raw.encrypted);
  if (!config || !config.host || !config.fromEmail) throw new Error("SMTP is not configured");
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port || 587,
    secure: Number(config.port) === 465,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  await transporter.sendMail({ from: `"${row?.storeName ?? "Store"}" <${config.fromEmail}>`, to, subject, html });
}

export async function sendNewsletterWelcome(email: string): Promise<void> {
  const brand = await getBrand();
  if (!brand) return;
  const html = layout(
    brand,
    heroCard(
      `Welcome to ${escapeHtml(brand.storeName)}! 🎉`,
      "You have subscribed to our newsletter. You will be the first to hear about new drops, restocks and exclusive offers.",
      brand.primaryLight
    ) +
      `<p style="font-size:14px;color:#475569;line-height:1.7;margin:20px 0 0;text-align:center;">No spam — one-click unsubscribe anytime. We are glad to have you on board.</p>`
  );
  await deliver(email, `Welcome to ${brand.storeName}!`, html);
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
  const brand = await getBrand();
  if (!brand) return;
  const rows = order.items
    .map(
      (i) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:14px;color:#111827;font-weight:600;">${escapeHtml(i.name)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:2px;">Quantity: ${i.qty}</div>
        </td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#111827;font-weight:700;white-space:nowrap;">${money(i.price * i.qty)}</td>
      </tr>`
    )
    .join("");
  const body = `
    <p style="font-size:16px;color:#111827;font-weight:700;margin:0 0 6px;">Hi ${escapeHtml(order.customerName || "there")},</p>
    <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 18px;">Thank you for your order at <strong>${escapeHtml(brand.storeName)}</strong>! Your order is confirmed. 😊</p>
    ${orderBox(order.orderId.slice(0, 8).toUpperCase(), "")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows}
      <tr><td colspan="2" style="height:10px;">&nbsp;</td></tr>
      ${priceRows([
        { label: "Subtotal", value: money(order.subtotal) },
        ...(order.discountAmount > 0 ? [{ label: "Discount", value: "- " + money(order.discountAmount), muted: true }] : []),
        { label: "Shipping", value: money(order.shippingCharge) },
      ])}
      <tr>
        <td style="padding:12px 0 0;border-top:2px solid #111827;">
          <span style="font-size:15px;font-weight:800;color:#111827;">Total</span>
        </td>
        <td align="right" style="padding:12px 0 0;border-top:2px solid #111827;">
          <span style="font-size:17px;font-weight:800;color:${brand.primary};">${money(order.totalAmount)}</span>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="border-radius:14px;background-color:#f8fafc;border:1px solid #eef0f3;padding:14px 18px;margin-top:22px;font-size:13px;color:#475569;">
          <strong style="display:block;font-size:11px;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">Payment</strong>
          ${escapeHtml(order.paymentMethod)}
        </td>
      </tr>
      <tr><td style="height:16px;">&nbsp;</td></tr>
    </table>`;
  await deliver(order.customerEmail, `Order #${order.orderId.slice(0, 8).toUpperCase()} confirmed — ${brand.storeName}`, layout(brand, body, "You can track your order from your profile."));
}

export async function sendNewOrderToOwner(order: {
  orderId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  items: { name: string; qty: number; price: number }[];
  subtotal: number;
  shippingCharge: number;
  discountAmount: number;
  totalAmount: number;
  paymentMethod: string;
}): Promise<void> {
  const brand = await getBrand();
  if (!brand) return;
  const rows = order.items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;color:#111827;font-size:14px;">${escapeHtml(i.name)} × ${i.qty}</td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #f1f5f9;color:#111827;font-size:14px;font-weight:700;white-space:nowrap;">${money(i.price * i.qty)}</td>
      </tr>`
    )
    .join("");
  const body = `
    <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 16px;">A new order just came in at <strong>${escapeHtml(brand.storeName)}</strong>. 🎉</p>
    ${orderBox(order.orderId.slice(0, 8).toUpperCase(), "")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;">
      <tr>
        <td style="border-radius:14px;background-color:#f8fafc;border:1px solid #eef0f3;padding:16px 18px;font-size:13px;color:#334155;line-height:1.8;">
          <strong style="font-size:11px;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;">Customer</strong><br/>
          Name: <strong>${escapeHtml(order.customerName || "—")}</strong><br/>
          Phone: <strong>${escapeHtml(order.customerPhone || "—")}</strong><br/>
          Email: ${escapeHtml(order.customerEmail || "—")}<br/>
          Payment: <strong>${escapeHtml(order.paymentMethod)}</strong>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows}
      <tr><td colspan="2" style="height:8px;">&nbsp;</td></tr>
      ${priceRows([
        { label: "Subtotal", value: money(order.subtotal) },
        ...(order.discountAmount > 0 ? [{ label: "Discount", value: "- " + money(order.discountAmount), muted: true }] : []),
        { label: "Shipping", value: money(order.shippingCharge) },
      ])}
      <tr>
        <td style="padding:12px 0 0;border-top:2px solid #111827;"><span style="font-size:15px;font-weight:800;color:#111827;">Total</span></td>
        <td align="right" style="padding:12px 0 0;border-top:2px solid #111827;"><span style="font-size:17px;font-weight:800;color:${brand.primary};">${money(order.totalAmount)}</span></td>
      </tr>
    </table>`;
  await deliver(brand.fromEmail, `New order #${order.orderId.slice(0, 8).toUpperCase()} — ${brand.storeName}`, layout(brand, body, "Confirm, pack and ship it from your admin panel."));
}

export async function sendOrderStatusEmail(order: {
  orderId: string;
  customerEmail: string;
  customerName: string;
  status: string;
}): Promise<void> {
  const brand = await getBrand();
  if (!brand) return;
  const st = (order.status || "").toUpperCase();
  const label = ORDER_STATUS_LABELS[st] ?? order.status;
  const message = ORDER_STATUS_MESSAGES[st] ?? `Your order status has been updated to ${escapeHtml(label)}.`;
  const isJourney = JOURNEY.includes(st);
  const body = `
    <p style="font-size:16px;color:#111827;font-weight:700;margin:0 0 6px;">Hi ${escapeHtml(order.customerName || "there")},</p>
    <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 22px;">Here is the latest update on your order:</p>
    ${heroCard(escapeHtml(label), escapeHtml(message), brand.primaryLight)}
    ${isJourney ? journey(st, brand.primary) : ""}
    ${orderBox(order.orderId.slice(0, 8).toUpperCase(), "")}
    <p style="font-size:14px;color:#64748b;line-height:1.7;margin:22px 0 0;text-align:center;">You can track the full journey of your order anytime from your profile.</p>`;
  await deliver(order.customerEmail, `Order #${order.orderId.slice(0, 8).toUpperCase()} — ${label}`, layout(brand, body, "Track it anytime from your profile."));
}

export async function sendTestMail(to: string): Promise<void> {
  const brand = await getBrand();
  if (!brand) {
    throw new Error("SMTP is not configured. Save Email SMTP settings first.");
  }
  const body =
    heroCard(
      `SMTP connection works! 🎉`,
      "This email was sent using your SMTP settings. Everything is connected and ready to deliver order &amp; status emails to your customers.",
      brand.primaryLight
    ) +
    `<p style="font-size:14px;color:#475569;line-height:1.7;margin:20px 0 0;text-align:center;">Sender host: <em>${escapeHtml(brand.fromEmail)}</em></p>`;
  await deliver(to, `Test email from ${brand.storeName}`, layout(brand, body));
}