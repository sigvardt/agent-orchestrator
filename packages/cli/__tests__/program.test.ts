import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";

describe("createProgram", () => {
  it("uses syn as the primary command name in help output", () => {
    const program = createProgram();
    const help = program.helpInformation();
    const normalizedHelp = help.replace(/\s+/g, " ");

    expect(program.name()).toBe("syn");
    expect(help).toContain("Usage: syn");
    expect(help).not.toContain("Usage: ao");
    expect(normalizedHelp).toContain("`syntese` and `ao` are also available as aliases");
  });
});
