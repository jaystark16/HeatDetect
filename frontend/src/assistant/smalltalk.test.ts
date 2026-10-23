import { describe, expect, it } from "vitest";

import { smallTalk } from "./smalltalk";

describe("small talk the page answers itself", () => {
  it("greets back instead of reciting statistics (observed: 'hello' got a detection count)", () => {
    for (const hello of ["hello", "Hi!", "hey there", "hii", "Good morning", "namaste"]) {
      expect(smallTalk(hello), hello).toMatch(/^Hi!/);
    }
  });

  it("answers thanks and goodbyes", () => {
    expect(smallTalk("thanks!")).toMatch(/welcome/);
    expect(smallTalk("thank you so much")).toMatch(/welcome/);
    expect(smallTalk("bye")).toMatch(/^Bye/);
    expect(smallTalk("how are you?")).toMatch(/Doing well/);
  });

  it("leaves anything with a real question to the model", () => {
    expect(smallTalk("hi, what is burning in odisha?")).toBeNull();
    expect(smallTalk("hello tell what happend in 24 hrs")).toBeNull();
    expect(smallTalk("thanks, now show me jharkhand")).toBeNull();
    expect(smallTalk("what else can you do?")).toBeNull();
  });
});
