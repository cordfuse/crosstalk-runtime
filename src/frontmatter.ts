import { parse as parseYaml } from 'yaml';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)/);
  if (!match) return { data: {}, body: content };
  const data = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  return { data, body: match[2] };
}
