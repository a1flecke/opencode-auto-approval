import { describe, expect, test } from "bun:test";
import { splitOutputFilters } from "../output-filters.js";

const WRAPPER = "./scripts/run-with-mise.sh yarn build";

describe("splitOutputFilters", () => {
  test.each([
    ["no pipe", WRAPPER],
    ["a bare 2>&1 is not a filter pipeline", `${WRAPPER} 2>&1`],
    ["a quoted pipe is not a split point", `git commit -m "a | b"`],
    ["a quoted pipe in single quotes", `git commit -m 'a | b'`],
  ])("none: %s", (_name, command) => {
    expect(splitOutputFilters(command)).toEqual({ kind: "none" });
  });

  test.each([
    [`${WRAPPER} | tail -20`, ["tail -20"]],
    [`${WRAPPER} 2>&1 | tail -20`, ["tail -20"]],
    [`${WRAPPER}  2>&1   |   tail -n 20  `, ["tail -n 20"]],
    [`${WRAPPER}|tail -5`, ["tail -5"]],
    [`${WRAPPER} | tail -n20`, ["tail -n20"]],
    [`${WRAPPER} | head -30`, ["head -30"]],
    [`${WRAPPER} | head -n 30`, ["head -n 30"]],
    [`${WRAPPER} | head -10000`, ["head -10000"]],
    [`${WRAPPER} | wc -l`, ["wc -l"]],
    [`${WRAPPER} | grep FAIL`, ["grep FAIL"]],
    [`${WRAPPER} | grep -E "FAIL|passed"`, [`grep -E "FAIL|passed"`]],
    [`${WRAPPER} | grep -i 'error: x'`, [`grep -i 'error: x'`]],
    [`${WRAPPER} | grep -v -n -c -F -i -E warn`, ["grep -v -n -c -F -i -E warn"]],
    [`${WRAPPER} | grep -Ei warn`, ["grep -Ei warn"]],
    [`${WRAPPER} | grep -E "^FAIL" | head -30`, [`grep -E "^FAIL"`, "head -30"]],
    [`${WRAPPER} 2>&1 | grep -E "FAIL|passed" | head -30`, [`grep -E "FAIL|passed"`, "head -30"]],
    [`${WRAPPER} 2>&1 | grep -v x | grep y | tail -3`, ["grep -v x", "grep y", "tail -3"]],
    [`${WRAPPER} | grep "a#b"`, [`grep "a#b"`]],
  ])("filtered: %s", (command, filters) => {
    expect(splitOutputFilters(command)).toEqual({ kind: "filtered", command: WRAPPER, filters });
  });

  test("the left-hand command is returned without the 2>&1 token", () => {
    expect(splitOutputFilters("git push origin HEAD 2>&1 | tail -3")).toEqual({
      kind: "filtered",
      command: "git push origin HEAD",
      filters: ["tail -3"],
    });
  });

  test.each([
    ["tail -f", `${WRAPPER} | tail -f`],
    ["tail --follow", `${WRAPPER} | tail --follow=name`],
    ["tail with a file", `${WRAPPER} | tail -20 build.log`],
    ["tail bare number is a file operand", `${WRAPPER} | tail 20`],
    ["tail without a count", `${WRAPPER} | tail`],
    ["tail -n +N", `${WRAPPER} | tail -n +5`],
    ["tail count too large", `${WRAPPER} | tail -10001`],
    ["tail zero", `${WRAPPER} | tail -0`],
    ["tail non-numeric", `${WRAPPER} | tail -n abc`],
    ["head with a file", `${WRAPPER} | head -5 README.md`],
    ["head -c", `${WRAPPER} | head -c 5`],
    ["wc -c", `${WRAPPER} | wc -c`],
    ["wc with a file", `${WRAPPER} | wc -l out.log`],
    ["wc bare", `${WRAPPER} | wc`],
    ["grep -r", `${WRAPPER} | grep -r x`],
    ["grep -R", `${WRAPPER} | grep -R x`],
    ["grep -f", `${WRAPPER} | grep -f patterns`],
    ["grep with a file operand", `${WRAPPER} | grep x file`],
    ["grep --include", `${WRAPPER} | grep --include=x y`],
    ["grep -e", `${WRAPPER} | grep -e x`],
    ["grep --", `${WRAPPER} | grep -- x`],
    ["grep with no pattern", `${WRAPPER} | grep -i`],
    ["grep empty pattern", `${WRAPPER} | grep ""`],
    ["grep pattern that looks like an option", `${WRAPPER} | grep -E "-f"`],
    ["grep unquoted glob pattern", `${WRAPPER} | grep FAIL*`],
    ["grep unquoted glob ?", `${WRAPPER} | grep FA?L`],
    ["grep unquoted bracket pattern", `${WRAPPER} | grep [a-z]`],
    ["grep unquoted brace expansion", `${WRAPPER} | grep a{b,c}`],
    ["grep unquoted tilde", `${WRAPPER} | grep ~root`],
    ["grep unquoted hash comment", `${WRAPPER} | grep x #y`],
    ["grep $ anchor", `${WRAPPER} | grep -E "x$"`],
    ["grep command substitution", `${WRAPPER} | grep "$(whoami)"`],
    ["grep backticks", `${WRAPPER} | grep "\`whoami\`"`],
    ["grep variable", `${WRAPPER} | grep "$HOME"`],
    ["grep backslash", `${WRAPPER} | grep "a\\b"`],
    ["grep semicolon inside quotes", `${WRAPPER} | grep "a;b"`],
    ["grep ampersand inside quotes", `${WRAPPER} | grep "a&b"`],
    ["grep parens inside quotes", `${WRAPPER} | grep -E "(a)"`],
    ["unbalanced double quote", `${WRAPPER} | grep "FAIL`],
    ["unbalanced single quote", `${WRAPPER} | grep 'FAIL`],
    ["tee", `${WRAPPER} | tee out`],
    ["sh", `${WRAPPER} | sh`],
    ["xargs", `${WRAPPER} | xargs rm`],
    ["awk", `${WRAPPER} | awk '{print}'`],
    ["sed", `${WRAPPER} | sed s/a/b/`],
    ["sort", `${WRAPPER} | sort`],
    ["cut", `${WRAPPER} | cut -d: -f1`],
    ["path-qualified filter", `${WRAPPER} | /usr/bin/tail -5`],
    ["env-prefixed filter", `${WRAPPER} | FOO=1 tail -5`],
    ["4 filters", `${WRAPPER} | grep a | grep b | grep c | head -5`],
    ["or-pipe", `${WRAPPER} || tail -5`],
    ["pipe-stderr", `${WRAPPER} |& tail -5`],
    ["empty filter", `${WRAPPER} | | tail -5`],
    ["trailing pipe", `${WRAPPER} |`],
    ["leading pipe", `| tail -5`],
    ["2>&1 after a pipe", `${WRAPPER} | tail -5 2>&1`],
    ["2>&1 twice", `${WRAPPER} 2>&1 2>&1 | tail -5`],
    ["2>&1 not last token of the command", `${WRAPPER} 2>&1 extra | tail -5`],
    ["redirect to a file", `${WRAPPER} > out.log | tail -5`],
    ["redirect after filter", `${WRAPPER} | tail -5 > out.log`],
    ["input redirect", `${WRAPPER} < in | tail -5`],
    ["2>/dev/null", `${WRAPPER} 2>/dev/null | tail -5`],
    ["&>", `${WRAPPER} &> out.log | tail -5`],
    ["semicolon after filter", `${WRAPPER} | tail -5; echo done`],
    ["semicolon in command", `${WRAPPER}; echo x | tail -5`],
    ["and-chain", `${WRAPPER} && other | tail -5`],
    ["and-chain after filter", `${WRAPPER} | tail -5 && other`],
    ["background", `${WRAPPER} & | tail -5`],
    ["$? after filter", `${WRAPPER} | tail -5; echo $?`],
    ["command substitution in command", `${WRAPPER} $(whoami) | tail -5`],
    ["backticks in command", `${WRAPPER} \`whoami\` | tail -5`],
    ["variable in command", `${WRAPPER} $HOME | tail -5`],
    ["subshell", `(${WRAPPER}) | tail -5`],
    ["backslash in command", `${WRAPPER} a\\ b | tail -5`],
    ["newline in command", `${WRAPPER}\nrm -rf x | tail -5`],
    ["newline in filter", `${WRAPPER} | tail -5\nrm -rf x`],
    ["carriage return", `${WRAPPER} | tail -5\rrm`],
    ["non-ASCII whitespace between filter words", `${WRAPPER} | tail -5`],
    ["comment in command", `${WRAPPER} #x | tail -5`],
  ])("invalid: %s", (_name, command) => {
    expect(splitOutputFilters(command)).toEqual({ kind: "invalid" });
  });
});
