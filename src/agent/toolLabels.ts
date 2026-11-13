import * as path from 'path';

function rel(cwd: string, p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) {
    return '.';
  }
  const raw = p.trim().replace(/^@/, '');
  if (path.isAbsolute(raw)) {
    const r = path.relative(cwd, raw);
    return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : raw;
  }
  return raw.replace(/\\/g, '/');
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 给工具调用生成面向学生的一行说明 */
export function describeTool(name: string, args: any, cwd: string): string {
  const a = args ?? {};
  switch (name) {
    case 'read': {
      const range =
        typeof a.offset === 'number'
          ? `（第 ${a.offset} 行起${typeof a.limit === 'number' ? `，${a.limit} 行` : ''}）`
          : '';
      return `读取 ${rel(cwd, a.path)}${range}`;
    }
    case 'grep':
      return `搜索「${clip(String(a.pattern ?? a.query ?? ''), 40)}」${a.path ? ` 于 ${rel(cwd, a.path)}` : ''}`;
    case 'find':
      return `查找 ${clip(String(a.pattern ?? a.name ?? '*'), 40)}${a.path ? ` 于 ${rel(cwd, a.path)}` : ''}`;
    case 'ls':
      return `列出目录 ${rel(cwd, a.path)}`;
    case 'edit':
      return `修改 ${rel(cwd, a.path)}`;
    case 'write':
      return `写入 ${rel(cwd, a.path)}`;
    case 'bash':
      return `运行 ${clip(String(a.command ?? ''), 80)}`;
    case 'get_diagnostics':
      return `查看诊断${a.path ? ` ${rel(cwd, a.path)}` : '（整个工作区）'}`;
    case 'update_plan':
      return '更新任务计划';
    default:
      return name;
  }
}

/** 取出工具结果里的文本内容 */
export function extractToolText(result: any): string {
  const content = result?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
  }
  return '';
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

export function clipHead(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
