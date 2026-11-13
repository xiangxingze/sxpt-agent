import * as vscode from 'vscode';

export interface ProjectOutline {
  root?: string;
  topLevel: string[];
  fileCount: number;
  techStack: string[];
  keyFiles: string[];
  summary: string;
}

const KEY_FILE_PATTERNS: Array<{ pattern: RegExp; label: string; stack?: string }> = [
  { pattern: /(^|\/)package\.json$/, label: 'Node/npm 工程', stack: 'Node.js' },
  { pattern: /(^|\/)tsconfig\.json$/, label: 'TypeScript 配置', stack: 'TypeScript' },
  { pattern: /\.csproj$/, label: '.NET 项目文件', stack: '.NET / C#' },
  { pattern: /\.sln$/, label: '.NET 解决方案', stack: '.NET' },
  { pattern: /(^|\/)pom\.xml$/, label: 'Maven 工程', stack: 'Java / Maven' },
  { pattern: /(^|\/)build\.gradle$/, label: 'Gradle 工程', stack: 'Java / Gradle' },
  { pattern: /(^|\/)requirements\.txt$/, label: 'Python 依赖', stack: 'Python' },
  { pattern: /(^|\/)pyproject\.toml$/, label: 'Python 工程配置', stack: 'Python' },
  { pattern: /(^|\/)go\.mod$/, label: 'Go 模块', stack: 'Go' },
  { pattern: /(^|\/)Cargo\.toml$/, label: 'Rust 工程', stack: 'Rust' },
  { pattern: /(^|\/)Dockerfile$/, label: 'Docker 镜像定义' },
  { pattern: /(^|\/)docker-compose\.ya?ml$/, label: 'Docker Compose 编排' },
  { pattern: /(^|\/)README(\.md)?$/i, label: '项目说明' }
];

const EXCLUDE_GLOB =
  '**/{node_modules,.git,out,dist,build,bin,obj,target,.venv,venv,__pycache__,.next,.cache}/**';

let cache: { outline: ProjectOutline; at: number } | undefined;
const CACHE_TTL_MS = 60_000;

export async function getProjectOutline(force = false): Promise<ProjectOutline | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.outline;
  }

  const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 600);
  if (files.length === 0) {
    return undefined;
  }

  const relative = files.map((uri) => vscode.workspace.asRelativePath(uri, false));
  const topLevelSet = new Set<string>();
  for (const rel of relative) {
    const first = rel.split('/')[0];
    topLevelSet.add(first.includes('.') && !rel.includes('/') ? '(根目录文件)' : first);
  }

  const techStack = new Set<string>();
  const keyFiles: string[] = [];
  for (const rel of relative) {
    for (const rule of KEY_FILE_PATTERNS) {
      if (rule.pattern.test(rel)) {
        if (rule.stack) {
          techStack.add(rule.stack);
        }
        if (keyFiles.length < 12) {
          keyFiles.push(`${rel}（${rule.label}）`);
        }
        break;
      }
    }
  }

  const topLevel = [...topLevelSet].sort().slice(0, 20);
  const summary = [
    `项目根目录：${folder.name}`,
    `已扫描文件数：${relative.length}（已排除依赖与构建产物）`,
    topLevel.length ? `顶层结构：${topLevel.join('、')}` : '',
    techStack.size ? `技术栈线索：${[...techStack].join('、')}` : '',
    keyFiles.length ? ['关键文件：', ...keyFiles.map((f) => `- ${f}`)].join('\n') : ''
  ]
    .filter(Boolean)
    .join('\n');

  const outline: ProjectOutline = {
    root: folder.name,
    topLevel,
    fileCount: relative.length,
    techStack: [...techStack],
    keyFiles,
    summary
  };
  cache = { outline, at: Date.now() };
  return outline;
}

export function clearProjectCache(): void {
  cache = undefined;
}
