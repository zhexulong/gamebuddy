import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entryUrl = new URL("../integrations/stardew/ModEntry.cs", import.meta.url);

test("native /stop does not display a transport acknowledgement before Host settlement", async () => {
  const entry = await readFile(entryUrl, "utf8");
  const methodStart = entry.indexOf("private void PublishNativeChat(");
  const methodEnd = entry.indexOf("private void OnModMessageReceived", methodStart);
  const publish = entry.slice(methodStart, methodEnd);

  assert.notEqual(methodStart, -1);
  assert.notEqual(methodEnd, -1);
  assert.match(entry, /this\.PublishNativeChat\(PlayerControlProtocol\.StopAll, null, chat\);/);
  assert.match(publish, /this\.Helper\.Multiplayer\.SendMessage\(message,/);
  assert.match(publish, /this\.MonitorNativeChatIngress\("dispatch_modmessage_send_attempted"\);/);
  assert.doesNotMatch(publish, /addInfoMessage\(/);
  assert.doesNotMatch(entry, /GameBuddy stop sent\./);
});
