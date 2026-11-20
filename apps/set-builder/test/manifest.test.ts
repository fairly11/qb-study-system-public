import {describe, expect, it} from "vitest";
import {createSetManifest, remainingSetItems, verifySetMembership} from "../src/index.js";
const input = {plan_id: "00000000-0000-4000-8000-000000000001", target_date: "2026-10-16",
  items: [{question_key:"115A65",position:1}, {question_key:"119C52",position:2}, {question_key:"118F33",position:3}]};
describe("ordered QB set manifest", () => {
  it("detects missing, unexpected companion, duplicate and reversed IDs", () => {
    const manifest = createSetManifest(input);
    expect(verifySetMembership(manifest, ["115A65","119C52","118F33"]).verified).toBe(true);
    expect(verifySetMembership(manifest, ["118F33","119C52","115A65"]).verified).toBe(false);
    expect(verifySetMembership(manifest, ["115A65","115A65","119C52","118F34"])).toMatchObject({
      missing:["118F33"],unexpected:["118F34"],duplicates:["115A65"],verified:false});
  });
  it("only resumes a verified ordered prefix", () => {
    const manifest = createSetManifest(input);
    expect(remainingSetItems(manifest, ["115A65"])).toEqual(["119C52","118F33"]);
    expect(() => remainingSetItems(manifest, ["119C52"])).toThrow("REVIEW_SET_RESUME_MISMATCH");
  });
  it("rejects duplicate and out of order plans before any UI write", () => {
    expect(() => createSetManifest({...input,items:[input.items[1]!]})).toThrow();
    expect(() => createSetManifest({...input,items:[input.items[0]!,{...input.items[0]!,position:2}]})).toThrow();
  });
});
