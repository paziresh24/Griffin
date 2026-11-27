import { test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "teleproto";
import { BinaryReader } from "teleproto/extensions";
import { createAccountTools, messageText, richInput } from "../src/integrations/telegram-account.mjs";

// Owner 2026-11-23: a message he wrote in Telegram's rich-text editor read as «Unsupported» with an
// empty text (gramjs stopped at layer 198); the agent could neither read it nor send one like it.
const richMessage = () =>
  new Api.Message({
    id: 486329,
    peerId: new Api.PeerUser({ userId: 272188041n }),
    date: 1795448733,
    message: "",
    out: true,
    richMessage: new Api.RichMessage({
      rtl: true,
      blocks: [
        new Api.PageBlockParagraph({ text: new Api.TextPlain({ text: "سلام و عرض ادب 👋" }) }),
        new Api.PageBlockHeading2({ text: new Api.TextPlain({ text: "20 گیگ" }) }),
        new Api.PageBlockParagraph({ text: new Api.TextBold({ text: new Api.TextPlain({ text: "و 2 کاربر همزمان" }) }) }),
        new Api.PageBlockPreformatted({ text: new Api.TextPlain({ text: "vless://link" }), language: "" }),
      ],
    }),
  });

test("a rich-text message survives the wire and reads back as Markdown", async () => {
  // The same bytes Telegram sends: write the layer-234 Message and read it back the way the client does.
  const bytes = richMessage().getBytes();
  const back = new BinaryReader(bytes).tgReadObject();
  const text = await messageText(back);
  assert.match(text, /سلام و عرض ادب/);
  assert.match(text, /## 20 گیگ/);
  assert.match(text, /\*\*و 2 کاربر همزمان\*\*/);
  assert.match(text, /```[\s\S]*vless:\/\/link[\s\S]*```/);
});

test("a plain message still reads its own text", async () => {
  assert.equal(await messageText({ message: "سلام" }), "سلام");
  assert.equal(await messageText(null), "");
});

test("rich input is Markdown, right-to-left when Persian", async () => {
  const fa = await richInput("## 20 گیگ\n\n```\nvless://x\n```");
  assert.equal(fa.className, "InputRichMessageMarkdown");
  assert.equal(fa.rtl, true);
  assert.match(fa.markdown ?? fa.text ?? JSON.stringify(fa), /20 گیگ/);
  assert.ok(!(await richInput("# hi")).rtl);
});

test("telegram_send and telegram_edit with rich: true send a rich message, not plain text", async () => {
  const calls = [];
  const client = {
    getInputEntity: async (c) => ({ id: 1, c }),
    getEntity: async (c) => ({ id: 1, c, firstName: "X" }),
    sendMessage: async (entity, opts) => (calls.push(["send", opts]), { id: 5 }),
    editMessage: async (entity, opts) => calls.push(["edit", opts]),
  };
  const tools = createAccountTools({ getClient: () => client });
  const sent = await tools.telegram_send.execute({ chat: "123", text: "## 20 گیگ", rich: true });
  assert.match(sent.content[0].text, /"sent":\s*true/);
  assert.equal(calls[0][1].message, undefined);
  assert.equal(calls[0][1].richMessage.className, "InputRichMessageMarkdown");
  await tools.telegram_edit.execute({ chat: "123", messageId: 5, text: "## 40 گیگ", rich: true });
  assert.equal(calls[1][1].message, 5);
  assert.equal(calls[1][1].richMessage.className, "InputRichMessageMarkdown");
  await tools.telegram_send.execute({ chat: "123", text: "ساده" });
  assert.equal(calls[2][1].message, "ساده");
  assert.equal(calls[2][1].richMessage, undefined);
  const both = await tools.telegram_send.execute({ chat: "123", text: "x", rich: true, file: "a.txt" });
  assert.match(both.content[0].text, /rich is for a text message/);
});
