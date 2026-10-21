import { RE2JS } from "re2js";
import { AssertionValueError } from "./selection.js";

export interface CompiledRegex {
  test(text: string): boolean;
  capture(text: string, group?: number, match?: "first" | "all"): string | string[] | undefined;
}
export function compileRegex(pattern: string, flags = ""): CompiledRegex {
  if (new TextEncoder().encode(pattern).length > 2048) throw new AssertionValueError("REGEX_LIMIT", "Pattern exceeds 2 KiB");
  if (!/^[ims]*$/.test(flags) || new Set(flags).size !== flags.length) throw new AssertionValueError("REGEX_CONFIG", "Only unique i/m/s flags are supported");
  const bits = (flags.includes("i") ? RE2JS.CASE_INSENSITIVE : 0)
    | (flags.includes("m") ? RE2JS.MULTILINE : 0) | (flags.includes("s") ? RE2JS.DOTALL : 0);
  let compiled: RE2JS;
  try { compiled = RE2JS.compile(pattern, bits); }
  catch (error) { throw new AssertionValueError("REGEX_CONFIG", `Unsupported RE2 pattern: ${String(error)}`); }
  return {
    test: (text) => compiled.matcher(text).find(),
    capture(text, group = 0, match = "first") {
      if (!Number.isInteger(group) || group < 0) throw new AssertionValueError("REGEX_CONFIG", "Group must be a nonnegative integer");
      if (group > compiled.groupCount()) return undefined;
      const matcher = compiled.matcher(text);
      const values: string[] = [];
      while (matcher.find()) {
        const value = matcher.group(group);
        if (match === "first") return value ?? undefined;
        if (value !== null) {
          if (values.length >= 1000) throw new AssertionValueError("REGEX_LIMIT", "Regex exceeds 1000 captures");
          values.push(value);
        }
      }
      return values.length ? values : undefined;
    },
  };
}
