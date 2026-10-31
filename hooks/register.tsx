import type { EngineInterface as Dollar, Register } from 'claude-code'

import { notesButton, notesPaneClosed, notesPromptContext, notesTool, registerNotes, startNotes } from './notes'
import { registerTasks, startTasks, tasksBand, tasksPaneClosed, tasksPromptContext, tasksTool } from './tasks'

function startFailed($: Dollar, err: unknown): void {
  $.ui.toast(`session-companion: ${err instanceof Error ? err.message : String(err)}`)
}

// A plugin may hook an event once, so the events both modules need are wired here.
export const register: Register = on => {
  registerTasks(on)
  registerNotes(on)

  // Each pane starts on its own: a failure in one leaves the other and the session as they are.
  on('session.start', async ($, e, next) => {
    await startTasks($).catch((err: unknown) => startFailed($, err))
    await startNotes($).catch((err: unknown) => startFailed($, err))
    return next(e)
  })

  // A failure in the plugin's own tool answers that call; any other call goes on.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const answer = await tasksTool($, tool, e)
      .then(found => found ?? notesTool($, tool, e))
      .catch((err: unknown) => ({ deny: `${tool}: ${err instanceof Error ? err.message : String(err)}` }))
    return answer ?? next(e)
  })

  // A hint that fails is left out: the prompt itself always goes on.
  on('prompt.submit', async ($, e, next) => {
    const tasks = await tasksPromptContext($, e.text).catch(() => [])
    // A slash command's text is the command's, not a message to take notes from.
    const notes = (e as { command?: unknown }).command ? [] : await notesPromptContext($, e.text).catch(() => [])
    const context = [...tasks, ...notes]
    return context.length ? next({ ...e, context: [...(e.context ?? []), ...context] }) : next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.origin.kind !== 'unload') {
      await tasksPaneClosed($, e.id).catch(() => undefined)
      await notesPaneClosed($, e.id).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // The engine's own node draws nothing here without a survey, and nested in a Box the surface refuses the band.
    const drawn = await next(e)
    const below = drawn.type === 'engine' ? null : drawn
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        {await tasksBand($, e)}
        <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent="flex-end">
          {below}
        </Box>
        <Box flexShrink={0}>{await notesButton($, e)}</Box>
      </Box>
    )
  })
}
