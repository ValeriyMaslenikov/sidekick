// Installs this repo's skills for a git-clone setup:
//   - symlinks skills/<name> into ~/.claude/skills and ~/.agents/skills
//   - adds the punch-list Stop hook to ~/.claude/settings.json (skip with --no-hook)
// Safe to run again.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir();
const targets = [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
const noHook = process.argv.includes('--no-hook');

for (const name of readdirSync(join(root, 'skills'))) {
  const src = join(root, 'skills', name);
  if (!existsSync(join(src, 'SKILL.md'))) continue;
  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    const link = join(dir, name);
    let current = null;
    try { current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : 'not-a-link'; } catch {}
    if (current === src) { console.log(`ok       ${link}`); continue; }
    if (current !== null) { console.log(`skipped  ${link} (already exists and points elsewhere; remove it to install)`); continue; }
    symlinkSync(src, link);
    console.log(`linked   ${link} -> ${src}`);
  }
}

if (!noHook) {
  const settingsPath = join(home, '.claude', 'settings.json');
  const command = `node "${join(root, 'skills', 'punch-list', 'bin', 'punch-list.mjs')}" hook-stop`;
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const stop = ((settings.hooks ??= {}).Stop ??= []);
  const present = stop.some((g) => (g.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('punch-list.mjs') && h.command.includes('hook-stop')));
  if (present) console.log('ok       Stop hook already in ~/.claude/settings.json');
  else {
    if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-sidekick`);
    stop.push({ hooks: [{ type: 'command', command }] });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`added    Stop hook to ~/.claude/settings.json (backup: settings.json.bak-sidekick)`);
  }
}
