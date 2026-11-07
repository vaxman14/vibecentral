import type { ViewFn } from '../router.ts';
import { overview } from './overview.ts';
import { projects } from './projects.ts';
import { project } from './project.ts';
import { tasks } from './tasks.ts';
import { history } from './history.ts';
import { domains, sites, databases, revenue, stores, help } from './simple.ts';
import { calendar } from './calendar.ts';
import { mail } from './mail.ts';
import { claude } from './claude.ts';
import { connections } from './connections.ts';
import { prefs } from './prefs.ts';

export const views: Record<string, ViewFn> = {
  overview, projects, project, tasks, history, domains, sites, databases, revenue, stores, calendar, mail, claude, connections, prefs, help,
};
