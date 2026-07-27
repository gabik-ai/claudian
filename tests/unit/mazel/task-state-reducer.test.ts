/**
 * Mazel patch: reducer for the stateful Task tools.
 *
 * Schemas and result strings here are not guessed. They were read off the live
 * tool definitions and off real calls on 2026-07-27:
 *   TaskCreate input : { subject, description, activeForm?, metadata? }  — no id
 *   TaskUpdate input : { taskId, status?, subject?, activeForm?, … }
 *   TaskCreate result: "Task #1 created successfully: <subject>"
 *   TaskUpdate result: "Updated task #1 status"
 *   TaskList  result: "#1 [in_progress] <subject>"
 */
import { extractTaskId, isTaskTool, TaskStateReducer } from '@/core/tools/taskState';

import { readUpstreamFile } from './upstreamRef';

function create(reducer: TaskStateReducer, toolUseId: string, subject: string, activeForm?: string) {
  reducer.noteToolUse(toolUseId, 'TaskCreate', {
    subject,
    description: `do ${subject}`,
    ...(activeForm ? { activeForm } : {}),
  });
}

function resolveCreate(reducer: TaskStateReducer, toolUseId: string, id: string, subject: string) {
  return reducer.applyToolResult(toolUseId, 'TaskCreate', `Task #${id} created successfully: ${subject}`);
}

describe('mazel: TaskStateReducer', () => {
  let reducer: TaskStateReducer;

  beforeEach(() => {
    reducer = new TaskStateReducer();
  });

  it('recognises all four task tool names and nothing else', () => {
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      expect(isTaskTool(name)).toBe(true);
    }
    for (const name of ['TodoWrite', 'Task', 'Read', 'TaskCreated']) {
      expect(isTaskTool(name)).toBe(false);
    }
  });

  it('creates nothing until the result arrives, because the input has no id', () => {
    create(reducer, 'tu_1', 'Run tests');
    // This is the whole reason the reducer buffers: after tool_use there is
    // still no id to key the task on.
    expect(reducer.toTodoItems()).toEqual([]);

    expect(resolveCreate(reducer, 'tu_1', '1', 'Run tests')).toBe(true);
    expect(reducer.toTodoItems()).toEqual([
      { content: 'Run tests', status: 'pending', activeForm: 'Run tests' },
    ]);
  });

  it('keeps the activeForm when one was supplied', () => {
    create(reducer, 'tu_1', 'Run tests', 'Running tests');
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');

    expect(reducer.toTodoItems()[0].activeForm).toBe('Running tests');
  });

  it('applies a status update straight from tool_use, without waiting for the result', () => {
    create(reducer, 'tu_1', 'Run tests');
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');

    expect(reducer.noteToolUse('tu_2', 'TaskUpdate', { taskId: '1', status: 'in_progress' })).toBe(true);
    expect(reducer.toTodoItems()[0].status).toBe('in_progress');
  });

  it('removes a deleted task instead of counting it as completed', () => {
    create(reducer, 'tu_1', 'Keep');
    resolveCreate(reducer, 'tu_1', '1', 'Keep');
    create(reducer, 'tu_2', 'Drop');
    resolveCreate(reducer, 'tu_2', '2', 'Drop');
    expect(reducer.size).toBe(2);

    reducer.noteToolUse('tu_3', 'TaskUpdate', { taskId: '2', status: 'deleted' });

    // The denominator in "Tasks n/m" comes straight off this list. A deleted
    // task counted as done makes the panel lie.
    expect(reducer.size).toBe(1);
    expect(reducer.toTodoItems().map(t => t.content)).toEqual(['Keep']);
    expect(reducer.toTodoItems().every(t => t.status !== 'completed')).toBe(true);
  });

  it('reads snake_case field names too', () => {
    reducer.noteToolUse('tu_1', 'TaskCreate', {
      subject: 'Run tests',
      description: 'x',
      active_form: 'Running tests',
    });
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');
    expect(reducer.toTodoItems()[0].activeForm).toBe('Running tests');

    reducer.noteToolUse('tu_2', 'TaskUpdate', { task_id: '1', status: 'completed' });
    expect(reducer.toTodoItems()[0].status).toBe('completed');
  });

  it('preserves creation order', () => {
    for (const [i, subject] of ['first', 'second', 'third'].entries()) {
      create(reducer, `tu_${i}`, subject);
      resolveCreate(reducer, `tu_${i}`, String(i + 1), subject);
    }
    expect(reducer.toTodoItems().map(t => t.content)).toEqual(['first', 'second', 'third']);
  });

  it('ignores a failed create so the list never gains a phantom task', () => {
    create(reducer, 'tu_1', 'Run tests');
    expect(reducer.applyToolResult('tu_1', 'TaskCreate', 'Error: quota exceeded', undefined, true)).toBe(false);
    expect(reducer.size).toBe(0);
  });

  it('ignores an update for a task it has never seen', () => {
    expect(reducer.noteToolUse('tu_1', 'TaskUpdate', { taskId: '99', status: 'completed' })).toBe(false);
    expect(reducer.size).toBe(0);
  });

  it('reports "no change" for a no-op update, so the panel does not rerender', () => {
    create(reducer, 'tu_1', 'Run tests');
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');
    reducer.noteToolUse('tu_2', 'TaskUpdate', { taskId: '1', status: 'in_progress' });

    expect(reducer.noteToolUse('tu_3', 'TaskUpdate', { taskId: '1', status: 'in_progress' })).toBe(false);
  });

  it('survives a duplicated tool_use, which the stream re-emits while input streams in', () => {
    create(reducer, 'tu_1', 'Run tests');
    create(reducer, 'tu_1', 'Run tests');
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');

    expect(reducer.size).toBe(1);
  });

  it('reconciles against TaskList output, repairing drift in both directions', () => {
    create(reducer, 'tu_1', 'Stale');
    resolveCreate(reducer, 'tu_1', '1', 'Stale');

    const changed = reducer.applyToolResult(
      'tu_2',
      'TaskList',
      ['#1 [completed] Stale', '#2 [in_progress] Created by a subagent'].join('\n'),
    );

    expect(changed).toBe(true);
    expect(reducer.toTodoItems()).toEqual([
      { content: 'Stale', status: 'completed', activeForm: 'Stale' },
      { content: 'Created by a subagent', status: 'in_progress', activeForm: 'Created by a subagent' },
    ]);
  });

  it('drops tasks the authoritative list no longer mentions', () => {
    create(reducer, 'tu_1', 'Gone');
    resolveCreate(reducer, 'tu_1', '1', 'Gone');
    create(reducer, 'tu_2', 'Stays');
    resolveCreate(reducer, 'tu_2', '2', 'Stays');

    reducer.applyToolResult('tu_3', 'TaskList', '#2 [pending] Stays');

    expect(reducer.toTodoItems().map(t => t.content)).toEqual(['Stays']);
  });

  it('ignores an empty TaskList rather than wiping the panel', () => {
    create(reducer, 'tu_1', 'Run tests');
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');

    expect(reducer.applyToolResult('tu_2', 'TaskList', 'No tasks yet.')).toBe(false);
    expect(reducer.size).toBe(1);
  });

  it('resets cleanly for a new conversation', () => {
    create(reducer, 'tu_1', 'Run tests');
    resolveCreate(reducer, 'tu_1', '1', 'Run tests');
    create(reducer, 'tu_2', 'Never resolved');

    reducer.reset();

    expect(reducer.size).toBe(0);
    expect(reducer.hasTasks()).toBe(false);
    // The buffered create must be gone too, or it would resolve into the next
    // conversation's list.
    expect(resolveCreate(reducer, 'tu_2', '2', 'Never resolved')).toBe(false);
    expect(reducer.size).toBe(0);
  });

  it('produces exactly the shape StatusPanel counts on', () => {
    for (const [i, subject] of ['a', 'b', 'c'].entries()) {
      create(reducer, `tu_${i}`, subject);
      resolveCreate(reducer, `tu_${i}`, String(i + 1), subject);
    }
    reducer.noteToolUse('u1', 'TaskUpdate', { taskId: '1', status: 'completed' });
    reducer.noteToolUse('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' });

    const todos = reducer.toTodoItems();
    const done = todos.filter(t => t.status === 'completed').length;
    expect(`Tasks ${done}/${todos.length}`).toBe('Tasks 1/3');
    for (const todo of todos) {
      expect(typeof todo.content).toBe('string');
      expect(typeof todo.activeForm).toBe('string');
      expect(['pending', 'in_progress', 'completed']).toContain(todo.status);
    }
  });
});

describe('mazel: extractTaskId', () => {
  it('prefers a structured payload', () => {
    expect(extractTaskId('irrelevant', { task: { id: '42', subject: 'x' } })).toBe('42');
    expect(extractTaskId('irrelevant', { taskId: '7' })).toBe('7');
    expect(extractTaskId('irrelevant', { task_id: '8' })).toBe('8');
  });

  it('falls back to the human-readable result text', () => {
    expect(extractTaskId('Task #1 created successfully: Probe')).toBe('1');
    expect(extractTaskId('Updated task #12 status')).toBe('12');
  });

  it('returns null when there is nothing to read', () => {
    expect(extractTaskId('')).toBeNull();
    expect(extractTaskId('something went wrong')).toBeNull();
  });
});

describe('obsolescence guard: task reducer', () => {
  it('upstream still does not know the task tool names', () => {
    // The day upstream implements this, our reducer is duplicate work and the
    // whole patch should be dropped in favour of theirs.
    const upstreamToolNames = readUpstreamFile('src/core/tools/toolNames.ts');
    if (upstreamToolNames === null) return;

    expect(upstreamToolNames).not.toContain('TaskCreate');
    expect(upstreamToolNames).not.toContain('TaskUpdate');
  });
});
