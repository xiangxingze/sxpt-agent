import { exec } from 'child_process';

const DANGEROUS = [
  /\brm\s+-[a-z]*[rf][a-z]*\b/,
  /\brm\s+--recursive\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s\b/i,
  /\bdrop\s+(database|schema|table)\b/i,
  /\btruncate\s+table\b/i,
  /\bdocker\s+system\s+prune\b/,
  /\bdocker\s+volume\s+rm\b/,
  /\bgit\s+push\s+--force\b/,
  /\bnpm\s+publish\b/,
  /:\s*\(\s*\)\s*\{.*\};\s*:/,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
  /\bwget\b[^|]*\|\s*(ba)?sh\b/,
  /\bsudo\b/,
  /\b(chmod|chown)\s+-R\b/,
  /\bchmod\b.*\b777\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/,
  /\bfind\b.*\s-delete\b/,
  /\bfind\b.*-exec\s+rm\b/,
  /\bRemove-Item\b.*-Recurse/i,
  /\b(rmtree|os\.remove|os\.rmdir|shutil\.move)\b/,
  />\s*\/dev\/(sd|nvme|hd)/,
  /\bkill(all)?\s+-9\s+(-1|1)\b/,
  /\bpkill\s+-9\b/
];

/** 含 shell 元字符的命令不能凭前缀白名单自动放行（`npm test && rm x`）。 */
const SHELL_META = /[;&|<>`$()\n\r]/;

export interface CommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export function isDangerous(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim();
  return DANGEROUS.some((re) => re.test(normalized));
}

export function isWhitelisted(command: string, allowList: string[]): boolean {
  if (allowList.length === 0) {
    return false;
  }
  const normalized = command.replace(/\s+/g, ' ').trim();
  return allowList.some((raw) => {
    const prefix = raw.replace(/\s+/g, ' ').trim();
    return prefix.length > 0 && (normalized === prefix || normalized.startsWith(`${prefix} `));
  });
}

export function hasShellMeta(command: string): boolean {
  return SHELL_META.test(command);
}

export type CommandRisk =
  | { level: 'blocked'; reason: string }
  | { level: 'auto' }
  | { level: 'confirm' };

/**
 * Agent 执行命令前的风险分级：
 * - blocked：命中高危规则，直接拒绝
 * - auto：命中白名单且不含 shell 元字符，可免确认
 * - confirm：其余命令需要学生确认
 */
export function classifyCommand(command: string, allowList: string[]): CommandRisk {
  const trimmed = command.trim();
  if (!trimmed) {
    return { level: 'blocked', reason: '命令为空' };
  }
  if (isDangerous(trimmed)) {
    return { level: 'blocked', reason: '命中高危命令规则（删除、强制重置、提权、管道执行等）' };
  }
  if (isWhitelisted(trimmed, allowList) && !hasShellMeta(trimmed)) {
    return { level: 'auto' };
  }
  return { level: 'confirm' };
}

export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise<CommandResult>((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const raw = `${stdout || ''}${stderr || ''}`;
        const limit = 20_000;
        const truncated = raw.length > limit;
        resolve({
          command,
          ok: !err,
          exitCode: err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0,
          output: truncated ? raw.slice(-limit) : raw,
          truncated,
          durationMs: Date.now() - started
        });
      }
    );
  });
}

export function detectTestCommand(techStack: string[]): { command: string; label: string }[] {
  const candidates: { command: string; label: string }[] = [];
  if (techStack.includes('Node.js')) {
    candidates.push({ command: 'npm test', label: 'npm test' });
    candidates.push({ command: 'npm run build', label: 'npm run build' });
  }
  if (techStack.includes('.NET / C#') || techStack.includes('.NET')) {
    candidates.push({ command: 'dotnet build', label: 'dotnet build' });
    candidates.push({ command: 'dotnet test', label: 'dotnet test' });
  }
  if (techStack.includes('Java / Maven')) {
    candidates.push({ command: 'mvn -q test', label: 'mvn test' });
  }
  if (techStack.includes('Java / Gradle')) {
    candidates.push({ command: './gradlew test', label: 'gradle test' });
  }
  if (techStack.includes('Python')) {
    candidates.push({ command: 'python -m pytest -q', label: 'pytest' });
  }
  if (techStack.includes('Go')) {
    candidates.push({ command: 'go test ./...', label: 'go test' });
  }
  return candidates;
}
