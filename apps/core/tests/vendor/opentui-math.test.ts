import { describe, expect, it } from "bun:test";

import { renderLatex, renderLatexToString } from "../../src/vendor/opentui-math/render";

describe("vendored opentui-math", () => {
  it("renders a centered fraction exactly", () => {
    expect(renderLatexToString("\\frac{12}{x}")).toBe(" 12\n\u2500\u2500\u2500\u2500\n x");
  });

  it("uses compact Unicode scripts", () => {
    expect(renderLatexToString("x^2_i")).toBe("x\u00b2\u1d62");
  });

  it("stretches matrix delimiters exactly", () => {
    expect(renderLatexToString("\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}")).toBe(
      "\u239ba b\u239e\n\u239c   \u239f\n\u239dc d\u23a0",
    );
  });

  it("preserves fraction geometry and baseline", () => {
    const layout = renderLatex("x+\\frac{a}{b}");
    expect({ width: layout.width, height: layout.height, baseline: layout.baseline }).toEqual({
      width: 7,
      height: 3,
      baseline: 1,
    });
  });

  it("rejects unknown commands in strict mode", () => {
    expect(() => renderLatexToString("\\unknown", { strict: true })).toThrow(
      "Unsupported command \\unknown at offset 0",
    );
  });
});
