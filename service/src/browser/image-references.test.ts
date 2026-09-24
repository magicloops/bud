import assert from "node:assert/strict";
import test from "node:test";
import { HYDRATED_IMAGE_LIMIT, hydratedImageIds, selectHydratedImageReferences } from "./image-references.js";
import type { CanonicalMessage } from "../llm/types.js";

const observe = (id: string, ok = true): CanonicalMessage => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id,
  content: JSON.stringify({ tool: "browser_exec", ok, data: { images: ok ? [{ id }] : [] } }) }] });

test("selection keeps the newest successful screenshots up to the hydration limit, in conversation order", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: "hello" },
    observe("failed", false),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "text", content: "plain text" }] },
    ...Array.from({ length: HYDRATED_IMAGE_LIMIT + 2 }, (_, i) => observe(`img${i}`)),
  ];
  const ids = hydratedImageIds(messages);
  assert.equal(ids.length, HYDRATED_IMAGE_LIMIT);
  assert.deepEqual(ids, Array.from({ length: HYDRATED_IMAGE_LIMIT }, (_, i) => `img${i + 2}`));
  assert.equal(selectHydratedImageReferences(messages).size, HYDRATED_IMAGE_LIMIT);
  // Prefix restriction reports only the hydrated images inside the measured request.
  assert.deepEqual(hydratedImageIds(messages, 5), ["img0", "img1"].filter(id => ids.includes(id)));
  assert.deepEqual(hydratedImageIds([]), []);
});

test("two images per cell share the eight-image replay budget including partial failures", () => {
  const messages:CanonicalMessage[] = Array.from({length:5},(_,i)=>({role:'user',content:[{type:'tool_result',tool_use_id:`cell${i}`,
    content:JSON.stringify({tool:'browser_exec',ok:false,data:{images:[{id:`${i}a`},{id:`${i}b`}]}})}]}));
  assert.deepEqual(hydratedImageIds(messages),['1a','1b','2a','2b','3a','3b','4a','4b']);
  messages.push({role:'user',content:[{type:'tool_result',tool_use_id:'private',content:JSON.stringify({tool:'browser_exec',data:{output_withheld:true,images:[{id:'secret'}]}})}]});
  assert.equal(hydratedImageIds(messages).includes('secret'),false);
});
