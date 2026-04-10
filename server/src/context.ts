import { SoulStorage } from "./storage.js";

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

export async function loadSoulContext(
  storage: SoulStorage,
  surface: string
): Promise<string> {
  const files: Record<string, string> = {};

  // Always load identity files
  for (const name of ["SOUL.md", "IDENTITY.md", "USER.md", "STYLE.md", "MEMORY.md"]) {
    try {
      files[name] = await storage.readFile(name);
    } catch {
      // File might not exist yet
    }
  }

  // Load today's and yesterday's daily logs (all surfaces)
  const todayStr = today();
  const yesterdayStr = yesterday();

  const dailyFiles = await storage.listFiles("daily");
  for (const f of dailyFiles) {
    if (f.includes(todayStr) || f.includes(yesterdayStr)) {
      try {
        files[f] = await storage.readFile(f);
      } catch {
        // skip
      }
    }
  }

  const fileList = Object.keys(files);
  const totalChars = Object.values(files).reduce(
    (sum, v) => sum + v.length,
    0
  );

  return (
    `Loaded ${fileList.length} files (${totalChars} chars) for surface "${surface}":\n` +
    fileList.map((f) => `- ${f}`).join("\n") +
    "\n\n" +
    Object.entries(files)
      .map(([name, content]) => `--- ${name} ---\n${content}`)
      .join("\n\n")
  );
}
