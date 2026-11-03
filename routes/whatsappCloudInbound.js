// whatsappCloudInbound.js
// ---------------------------------------------------------------------------------------------
// Turns ONE incoming WhatsApp Cloud API webhook message (entry[].changes[].value.messages[i])
// into the fields your ChatMessage needs, so that Cloud API chats show voice notes, images,
// videos, documents, stickers, LOCATIONS and CONTACTS exactly like the QR (Baileys) chats do.
//
// Usage inside your Cloud API webhook handler:
//
//   const { mapCloudInboundMessage } = require("./whatsappCloudInbound");
//   ...
//   const m = mapCloudInboundMessage(message);   // `message` = value.messages[i]
//   await new ChatMessage({
//     userId, messageId: message.id, customerPhone, customerName,
//     platform: "whatsapp", sender: "them", status: "unread",
//     type: m.type, text: m.text,
//     ...(m.mediaUrl ? { mediaUrl: m.mediaUrl } : {}),   // Meta media id -> /api/chats/media-proxy
//     ...m.extra                                          // { location } / { contacts } / { fileName }
//   }).save();
// ---------------------------------------------------------------------------------------------

function buildVcard(name, phones) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${name || "Contact"}`];
  (phones || []).forEach((p) => lines.push(`TEL;type=CELL:${p}`));
  lines.push("END:VCARD");
  return lines.join("\n");
}

function mapCloudInboundMessage(message = {}) {
  const t = message.type;
  const out = { type: "text", text: "", mediaUrl: "", extra: {} };

  switch (t) {
    case "text":
      out.text = message.text?.body || "";
      break;

    case "audio": {
      const a = message.audio || {};
      out.type = a.voice ? "voice" : "audio";
      out.text = "[Voice Note]";            // the website hides this placeholder when the audio player is shown
      out.mediaUrl = a.id || "";
      break;
    }

    case "image":
      out.type = "image";
      out.text = message.image?.caption || "[Image Attachment]";
      out.mediaUrl = message.image?.id || "";
      break;

    case "video":
      out.type = "video";
      out.text = message.video?.caption || "[Video Attachment]";
      out.mediaUrl = message.video?.id || "";
      break;

    case "sticker":
      out.type = "image";
      out.text = "[Sticker]";
      out.mediaUrl = message.sticker?.id || "";
      break;

    case "document": {
      const d = message.document || {};
      out.type = "document";
      out.text = d.caption || d.filename || "[Document]";
      out.mediaUrl = d.id || "";
      if (d.filename) out.extra.fileName = d.filename;
      break;
    }

    case "location": {
      // Cloud API location payload: { latitude, longitude, name?, address?, url? }
      const l = message.location || {};
      const lat = Number(l.latitude);
      const lng = Number(l.longitude);
      const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      out.type = "location";
      out.text = ["📍 Location", l.name, l.address, mapUrl].filter(Boolean).join("\n");
      out.extra.location = { latitude: lat, longitude: lng, name: l.name || "", address: l.address || "", isLive: false, url: mapUrl };
      break;
    }

    case "contacts": {
      // Cloud API contacts payload: [{ name: { formatted_name }, phones: [{ phone, wa_id, type }] }]
      const cards = (message.contacts || []).map((c) => {
        const name = c.name?.formatted_name || [c.name?.first_name, c.name?.last_name].filter(Boolean).join(" ") || "Contact";
        const phones = (c.phones || []).map((p) => p.phone || p.wa_id).filter(Boolean);
        return { name, phones, vcard: buildVcard(name, phones) };
      });
      out.type = "contacts";
      out.text = cards.map((c) => c.vcard).join("\n") || "[Contact]";   // vCard in text = website can always draw the card
      out.extra.contacts = cards;
      break;
    }

    case "button":
      out.text = message.button?.text || "";
      break;

    case "interactive": {
      const i = message.interactive || {};
      out.text = i.button_reply?.title || i.list_reply?.title || "";
      break;
    }

    case "unsupported":
    default:
      // Meta sends "unsupported" for things Cloud API cannot deliver (for example some location / poll / edit types)
      out.text = `[Unsupported message${message.unsupported?.type ? `: ${message.unsupported.type}` : ""}]`;
      break;
  }

  return out;
}

module.exports = { mapCloudInboundMessage };
