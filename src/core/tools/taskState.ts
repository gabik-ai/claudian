/**
 * Reducer for the stateful Task tools.
 *
 * Anthropic replaced the single `TodoWrite` call, which shipped the whole list
 * every time, with four stateful tools: `TaskCreate`, `TaskUpdate`, `TaskList`
 * and `TaskGet`. Nothing in the stream carries the full list any more, so the
 * client has to keep it. Without that, the status panel stays empty forever and
 * the raw tool calls show up as text — upstream issue #934.
 *
 * This reducer folds the stream back into the `TodoItem[]` shape that
 * StatusPanel and TodoListRenderer already consume, so neither of them needs to
 * change at all.
 *
 * Three things make this harder than it looks:
 *
 *  1. **TaskCreate's input has no id.** Verified against the live tool schema:
 *     the input is `{subject, description, activeForm?, metadata?}` and nothing
 *     else. The id only appears in the tool RESULT. So a create has to be
 *     buffered under its tool-use id and resolved when the result arrives.
 *  2. **`status: "deleted"` is a removal, not a completion.** Counting it as
 *     done drifts the denominator in "Tasks n/m" and the panel starts lying.
 *  3. **Field names have to be read defensively.** Claude Code repairs
 *     `id`/`task_id` → `taskId` and `active_form` → `activeForm` internally, but
 *     that repair is not reflected in the stream.
 */

import type { TodoItem } from './todo';
import {
  TOOL_TASK_CREATE,
  TOOL_TASK_GET,
  TOOL_TASK_LIST,
  TOOL_TASK_UPDATE,
} from './toolNames';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface TaskRecord {
  id: string;
  subject: string;
  activeForm: string;
  status: TaskStatus;
}

interface PendingCreate {
  subject: string;
  activeForm: string;
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'];

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads the first present key, so `taskId` / `task_id` / `id` all work. */
function pick(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = str(source[key]);
    if (value) return value;
  }
  return null;
}

function readStatus(value: unknown): TaskStatus | 'deleted' | null {
  if (typeof value !== 'string') return null;
  if (value === 'deleted') return 'deleted';
  return STATUSES.includes(value) ? (value as TaskStatus) : null;
}

/**
 * Digs a task id out of a tool result, whichever way the runtime chose to
 * report it. Structured payload first, then the human-readable text, which is
 * stable enough to rely on as a fallback:
 *   "Task #1 created successfully: <subject>"
 *   "Updated task #1 status"
 */
export function extractTaskId(content: string, structured?: unknown): string | null {
  if (structured && typeof structured === 'object') {
    const record = structured as Record<string, unknown>;
    const direct = pick(record, 'taskId', 'task_id', 'id');
    if (direct) return direct;

    const nested = record.task;
    if (nested && typeof nested === 'object') {
      const nestedId = pick(nested as Record<string, unknown>, 'taskId', 'task_id', 'id');
      if (nestedId) return nestedId;
    }
  }

  const match = /(?:task\s*#|#)\s*([A-Za-z0-9_-]+)/i.exec(content ?? '');
  return match ? match[1] : null;
}

export function isTaskTool(name: string): boolean {
  return (
    name === TOOL_TASK_CREATE
    || name === TOOL_TASK_UPDATE
    || name === TOOL_TASK_LIST
    || name === TOOL_TASK_GET
  );
}

export class TaskStateReducer {
  /** Insertion order is display order, which is also creation order. */
  private readonly tasks = new Map<string, TaskRecord>();
  /** TaskCreate inputs waiting for the result that carries their id. */
  private readonly pendingCreates = new Map<string, PendingCreate>();

  /**
   * Called for every `tool_use` chunk, including re-emissions while the input
   * is still streaming in.
   *
   * A TaskUpdate is applied here rather than on the result, because its input
   * already carries the taskId — waiting would leave the panel a full round
   * trip behind the model.
   */
  noteToolUse(toolUseId: string, name: string, input: Record<string, unknown> | undefined): boolean {
    if (!input) return false;

    if (name === TOOL_TASK_CREATE) {
      const subject = pick(input, 'subject', 'content', 'title');
      if (!subject) return false;
      this.pendingCreates.set(toolUseId, {
        subject,
        activeForm: pick(input, 'activeForm', 'active_form') ?? subject,
      });
      return false;
    }

    if (name === TOOL_TASK_UPDATE) {
      const taskId = pick(input, 'taskId', 'task_id', 'id');
      if (!taskId) return false;
      return this.applyUpdate(taskId, input);
    }

    return false;
  }

  /**
   * Called for every `tool_result`. Returns true when the visible list changed.
   */
  applyToolResult(
    toolUseId: string,
    name: string,
    content: string,
    structured?: unknown,
    isError?: boolean,
  ): boolean {
    if (name === TOOL_TASK_CREATE) {
      const pending = this.pendingCreates.get(toolUseId);
      this.pendingCreates.delete(toolUseId);
      // A failed create must not invent a task, or the denominator drifts.
      if (!pending || isError) return false;

      const id = extractTaskId(content, structured);
      if (!id || this.tasks.has(id)) return false;

      this.tasks.set(id, {
        id,
        subject: pending.subject,
        activeForm: pending.activeForm,
        status: 'pending',
      });
      return true;
    }

    if (name === TOOL_TASK_LIST) {
      return this.reconcileFromList(content);
    }

    return false;
  }

  private applyUpdate(taskId: string, input: Record<string, unknown>): boolean {
    const status = readStatus(input.status);

    if (status === 'deleted') {
      // Removal, not completion. Anything else drifts "n/m".
      return this.tasks.delete(taskId);
    }

    const existing = this.tasks.get(taskId);
    if (!existing) return false;

    const subject = pick(input, 'subject', 'content', 'title');
    const activeForm = pick(input, 'activeForm', 'active_form');

    const next: TaskRecord = {
      ...existing,
      ...(status ? { status } : {}),
      ...(subject ? { subject } : {}),
      ...(activeForm ? { activeForm } : {}),
    };

    if (
      next.status === existing.status
      && next.subject === existing.subject
      && next.activeForm === existing.activeForm
    ) {
      return false;
    }

    this.tasks.set(taskId, next);
    return true;
  }

  /**
   * `TaskList` prints the authoritative list as `#1 [in_progress] Subject`.
   * Folding it back in repairs any drift — a create whose result we missed, or
   * a task created by a subagent we never saw the tool call for.
   */
  private reconcileFromList(content: string): boolean {
    const pattern = /^\s*#?([A-Za-z0-9_-]+)\s*\[(pending|in_progress|completed)\]\s*(.+?)\s*$/gm;
    let changed = false;
    const seen = new Set<string>();

    for (const match of content.matchAll(pattern)) {
      const [, id, rawStatus, subject] = match;
      seen.add(id);
      const status = rawStatus as TaskStatus;
      const existing = this.tasks.get(id);

      if (!existing) {
        this.tasks.set(id, { id, subject, activeForm: subject, status });
        changed = true;
      } else if (existing.status !== status || existing.subject !== subject) {
        this.tasks.set(id, { ...existing, status, subject });
        changed = true;
      }
    }

    if (seen.size === 0) return false;

    // Anything the authoritative list no longer mentions was deleted.
    for (const id of [...this.tasks.keys()]) {
      if (!seen.has(id)) {
        this.tasks.delete(id);
        changed = true;
      }
    }

    return changed;
  }

  /** Projection into the shape StatusPanel and TodoListRenderer already speak. */
  toTodoItems(): TodoItem[] {
    return [...this.tasks.values()].map(task => ({
      content: task.subject,
      status: task.status,
      activeForm: task.activeForm,
    }));
  }

  get size(): number {
    return this.tasks.size;
  }

  hasTasks(): boolean {
    return this.tasks.size > 0;
  }

  reset(): void {
    this.tasks.clear();
    this.pendingCreates.clear();
  }
}
