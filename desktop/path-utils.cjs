function decodeGitPath(value) {
  const source = String(value || "");
  if (!(source.startsWith('"') && source.endsWith('"'))) return source;
  const body = source.slice(1, -1);
  const bytes = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      bytes.push(...Buffer.from(character));
      continue;
    }
    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const escaped = body[index + 1];
    const mapped = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" }[escaped];
    bytes.push(...Buffer.from(mapped ?? escaped ?? "\\"));
    if (escaped) index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

module.exports = { decodeGitPath };
