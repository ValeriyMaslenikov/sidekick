import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  home: string;
  config: string;
  token: string;
  state: string;
  boards: string;
  serverLog: string;
  boardDir(id: string): string;
}

/** Where punch-list keeps its files. `SIDEKICK_HOME` overrides `~/.sidekick`. */
export function paths(): Paths {
  const home = process.env.SIDEKICK_HOME || join(homedir(), '.sidekick');
  const boards = join(home, 'boards');
  return {
    home,
    config: join(home, 'config.json'),
    token: join(home, 'token'),
    state: join(home, 'state.json'),
    boards,
    serverLog: join(home, 'server.log'),
    boardDir: (id) => join(boards, id),
  };
}
