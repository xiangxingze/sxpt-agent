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
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/
];

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
  const normalized = command.trim();
  return allowList.some((prefix) => normalized.startsWith(prefix.trim()));
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
