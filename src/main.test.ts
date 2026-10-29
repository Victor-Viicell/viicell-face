import { describe, expect, test } from "bun:test";

/**
 * `main.ts` is boot and wiring: it builds the objects and connects them.
 *
 * The rule is a size, so the rule is a test. Two sessions in a row grew the file
 * by adding to it wherever the mood struck, and the result was a 1514-line file
 * that no session wanted to touch. Anything with a rule of its own belongs in
 * one of the modules beside it; if this fails, split it out instead of raising
 * the number.
 */
describe("main.ts", () => {
  const source = async (): Promise<string[]> =>
    (await Bun.file(`${import.meta.dir}/main.ts`).text()).split("\n");

  test("stays small enough to read in one sitting", async () => {
    const lines = await source();
    expect(lines.length).toBeLessThan(250);
  });

  test("holds no element lookup: the ids live in shell.ts", async () => {
    const lookups = (await source()).filter((line) => line.includes("querySelector"));
    expect(lookups).toEqual([]);
  });
});
