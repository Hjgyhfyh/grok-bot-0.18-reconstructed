import { homedir } from "node:os";
import { buildMentionedAgentsContext } from "../../agents/agent-messaging.js";
import { parseGroupMentions } from "../../groups/group-chat.js";
import {
  collectWorkflowReferences,
  deriveWorkflowNameFromUrl,
  limitSurfacedWorkflows,
  WORKFLOW_INJECTED_BODY_LIMIT,
  workflowDir,
  workflowToAutomation,
  type WorkflowRecord,
  type WorkflowSpec,
} from "../../../shared/workflow-model.js";
import { WORKFLOW_REFERENCE_NODE_TYPE } from "../../../shared/workflows.js";
import { AUTOMATION_WAKE_CUE } from "../../../shared/automations.js";
import { formatTimestamp } from "../../../shared/automation-schedule.js";
import { SandAgentNotFoundError } from "../session/agent-errors.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

function buildWorkflowRunPrompt(
  workflow: WorkflowRecord,
  options: { trigger: "reference" | "schedule" },
  timeZone?: string,
): string {
  const lines: string[] = [];
  if (options.trigger === "schedule") {
    lines.push(
      `${AUTOMATION_WAKE_CUE} workflow "${workflow.name}" (folder ${workflow.id}) is due on its schedule — fired ${formatTimestamp(Date.now(), timeZone)}.`,
      "This is your own standing order firing on schedule, not a message the user just typed.",
    );
  } else {
    const identity =
      workflow.source === "managed"
        ? `managed skill id ${workflow.id}`
        : workflow.source === "plugin"
          ? `plugin skill id ${workflow.id}, file ${workflow.filePath}`
          : `folder ${workflow.id}`;
    lines.push(
      `The user invoked the "${workflow.name}" workflow (${identity}). Run it now.`,
    );
  }
  if (workflow.description.length > 0)
    lines.push(`What it does: ${workflow.description}`);
  lines.push(
    "Recipe to follow:",
    workflow.body.trim().slice(0, WORKFLOW_INJECTED_BODY_LIMIT),
  );
  if (workflow.helperScripts.length > 0) {
    lines.push(
      `Helper files live beside this workflow in ${workflowDir(workflow.filePath)}: ${workflow.helperScripts.join(", ")}. Use them with Shell as the recipe directs.`,
    );
  }
  lines.push(
    options.trigger === "schedule"
      ? "Carry it out now and surface anything worth sharing with SendMessage, casually — unless the recipe says to stay quiet when there's nothing to report."
      : "Carry out the recipe now, adapting it to anything else the user said in this message.",
  );
  return lines.join("\n");
}

export class WorkflowCommands {
  watchedWorkflows: any;

  constructor(readonly tm: TranscriptManagerLike) {}

  /**
   * Refuses a change to the routines of an agent that is not on disk.
   *
   * The same guard `AutomationRuntime` carries, for the same measurement: the
   * routine commands never checked, and every one of them answered `200` with an
   * empty or unchanged list for an id that names nothing. Measured on this
   * machine over a real `SandAgentSessionStore`, each of `createAgentWorkflow`,
   * `updateAgentWorkflow`, `setAgentWorkflowEnabled`, `removeAgentWorkflow` and
   * `importAgentWorkflowMarkdown` returned normally for a deleted agent, so a
   * stale routine edit reported itself as saved against an agent that is gone.
   *
   * The class is `SandAgentNotFoundError`, which `statusForCommandError` maps to
   * `404` — the same answer the sidebar switches give for the same fact.
   */
  private requireAgentOnDisk(agentId: string, command: string): void {
    if (!this.tm.sessionStore.agentDirExists(agentId))
      throw new SandAgentNotFoundError(
        `Agent ${agentId} no longer exists on disk.`,
      );
  }

  enqueueWorkflowMutation<T>(args: {
    agentId: string;
    activeMutation(session: any): T;
    inactiveMutation(): T;
  }): Promise<T> {
    return this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
      agentId: args.agentId,
      mutation: () => {
        const active = this.tm.sessions.activeSession;
        if (active?.id === args.agentId) {
          this.tm.automationRuntime.recordAutomationChangeEvents(
            active,
            "agent",
          );
          const workflows = args.activeMutation(active);
          this.tm.automationRuntime.recordAutomationChangeEvents(
            active,
            "workflow_ui",
          );
          return workflows;
        }
        const before = this.tm.sessionStore.listAgentAutomations(args.agentId);
        this.tm.automationRuntime.recordInactiveAutomationChanges({
          agentId: args.agentId,
          before,
          after: before,
          source: "agent",
        });
        const workflows = args.inactiveMutation();
        const after = this.tm.sessionStore.listAgentAutomations(args.agentId);
        this.tm.automationRuntime.recordInactiveAutomationChanges({
          agentId: args.agentId,
          before,
          after,
          source: "workflow_ui",
        });
        return workflows;
      },
    });
  }

  watchSessionWorkflows(session: any): void {
    if (this.watchedWorkflows === session.workflows) return;
    this.watchedWorkflows?.setOnChange(undefined);
    this.watchedWorkflows = session.workflows;
    session.workflows.setOnChange(() => this.emitWorkflows(session));
  }
  emitWorkflows(session: any): void {
    if (
      this.tm.sessions.activeSession?.id !== session.id ||
      !this.tm.shouldEmitAutomations()
    )
      return;
    this.tm.roster.emitter.emit("workflows", {
      agentId: session.id,
      workflows: limitSurfacedWorkflows(session.workflows.listAll()),
    });
  }
  subscribeWorkflows(listener: (value: unknown) => void): () => void {
    this.tm.roster.emitter.on("workflows", listener);
    return () => this.tm.roster.emitter.off("workflows", listener);
  }
  async getAgentWorkflows(agentId: string): Promise<WorkflowRecord[]> {
    const active = this.tm.sessions.activeSession;
    return active?.id === agentId
      ? limitSurfacedWorkflows(active.workflows.listAll())
      : this.tm.sessionStore.listAgentWorkflows(agentId);
  }
  createAgentWorkflow(
    agentId: string,
    spec: WorkflowSpec,
  ): Promise<WorkflowRecord[]> {
    this.requireAgentOnDisk(agentId, "createAgentWorkflow");
    return this.enqueueWorkflowMutation({
      agentId,
      activeMutation: (active) => {
        active.workflows.create(spec);
        return limitSurfacedWorkflows(active.workflows.listAll());
      },
      inactiveMutation: () =>
        this.tm.sessionStore.createAgentWorkflow(agentId, spec),
    });
  }
  updateAgentWorkflow(
    agentId: string,
    workflowId: string,
    spec: WorkflowSpec,
  ): Promise<WorkflowRecord[]> {
    this.requireAgentOnDisk(agentId, "updateAgentWorkflow");
    return this.enqueueWorkflowMutation({
      agentId,
      activeMutation: (active) => {
        active.workflows.update(workflowId, spec);
        return limitSurfacedWorkflows(active.workflows.listAll());
      },
      inactiveMutation: () =>
        this.tm.sessionStore.updateAgentWorkflow(agentId, workflowId, spec),
    });
  }
  setAgentWorkflowEnabled(
    agentId: string,
    workflowId: string,
    isEnabled: boolean,
  ): Promise<WorkflowRecord[]> {
    this.requireAgentOnDisk(agentId, "setAgentWorkflowEnabled");
    // This used to touch the store directly, so it was the only one of the four
    // mutations that skipped the per-agent queue and the lifecycle record. A
    // routine paused here changed nothing the scheduler or the audit trail could
    // see: no `automation-changed` event, no `sand.automation.lifecycle` row,
    // and no serialization against a create or with a run recording its own diff.
    return this.enqueueWorkflowMutation({
      agentId,
      activeMutation: (active) => {
        active.workflows.setEnabledForAgent(workflowId, isEnabled);
        return limitSurfacedWorkflows(active.workflows.listAll());
      },
      inactiveMutation: () =>
        this.tm.sessionStore.setAgentWorkflowEnabled(
          agentId,
          workflowId,
          isEnabled,
        ),
    });
  }
  deleteAgentWorkflow(
    agentId: string,
    workflowId: string,
  ): Promise<WorkflowRecord[]> {
    this.requireAgentOnDisk(agentId, "deleteAgentWorkflow");
    return this.enqueueWorkflowMutation({
      agentId,
      activeMutation: (active) => {
        active.workflows.remove(workflowId);
        return limitSurfacedWorkflows(active.workflows.listAll());
      },
      inactiveMutation: () =>
        this.tm.sessionStore.removeAgentWorkflow(agentId, workflowId),
    });
  }

  async importAgentWorkflowMarkdown(
    agentId: string,
    markdown: string,
    fallbackName?: string,
  ): Promise<unknown> {
    this.requireAgentOnDisk(agentId, "importAgentWorkflowMarkdown");
    const active = this.tm.sessions.activeSession;
    if (active?.id !== agentId)
      return this.tm.sessionStore.importAgentWorkflowMarkdown(
        agentId,
        markdown,
        fallbackName,
      );
    const imported = active.workflows.importMarkdown(markdown, fallbackName);
    return {
      workflows: limitSurfacedWorkflows(active.workflows.listAll()),
      result:
        imported == null
          ? {
              imported: [],
              skipped: [{ source: "pasted skill", reason: "empty or invalid" }],
            }
          : { imported: [imported], skipped: [] },
    };
  }
  async importAgentWorkflowSource(
    agentId: string,
    source: string,
    fallbackName?: string,
  ): Promise<unknown> {
    this.requireAgentOnDisk(agentId, "importAgentWorkflowSource");
    const active = this.tm.sessions.activeSession;
    if (active?.id !== agentId)
      return this.tm.sessionStore.importAgentWorkflowSource(
        agentId,
        source,
        fallbackName,
      );
    const imported = active.workflows.importLiveSource(source, fallbackName);
    return {
      workflows: limitSurfacedWorkflows(active.workflows.listAll()),
      result:
        imported == null
          ? { imported: [], skipped: [{ source, reason: "could not link" }] }
          : { imported: [imported], skipped: [] },
    };
  }
  importAgentWorkflowUrl(
    agentId: string,
    url: string,
    name?: string,
  ): Promise<unknown> {
    return this.importAgentWorkflowSource(
      agentId,
      url,
      name ?? deriveWorkflowNameFromUrl(url),
    );
  }
  async portAgentLocalSkills(agentId: string): Promise<unknown> {
    this.requireAgentOnDisk(agentId, "portAgentLocalSkills");
    const active = this.tm.sessions.activeSession;
    if (active?.id !== agentId)
      return this.tm.sessionStore.portAgentLocalSkills(agentId);
    const result = active.workflows.portLocalSkills(homedir(), process.cwd());
    return {
      workflows: limitSurfacedWorkflows(active.workflows.listAll()),
      result,
    };
  }
  async runAgentWorkflowNow(
    agentId: string,
    workflowId: string,
  ): Promise<void> {
    this.requireAgentOnDisk(agentId, "runAgentWorkflowNow");
    const workflow = await this.getWorkflowForAgent(agentId, workflowId);
    if (workflow == null) return;
    const automation = workflowToAutomation(workflow);
    if (automation != null) {
      await this.tm.automationRuntime.fireAutomation({
        agentId,
        automation,
        trigger: "manual",
      });
      return;
    }
    await this.tm.sendPrompt(`@${workflow.name}`, {
      richText: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: WORKFLOW_REFERENCE_NODE_TYPE,
                attrs: { id: workflow.id, label: workflow.name },
              },
            ],
          },
        ],
      }),
    });
  }
  async getWorkflowForAgent(
    agentId: string,
    workflowId: string,
  ): Promise<WorkflowRecord | null> {
    const active = this.tm.sessions.activeSession;
    return active?.id === agentId
      ? active.workflows.get(workflowId)
      : this.tm.sessionStore.getAgentWorkflow(agentId, workflowId);
  }
  expandWorkflowReferences(
    session: any,
    prompt: string,
    richText?: string,
  ): string {
    const blocks: string[] = [];
    for (const reference of collectWorkflowReferences(richText)) {
      const workflow = session.workflows.get(
        reference.id,
      ) as WorkflowRecord | null;
      if (
        workflow == null ||
        (!workflow.isEnabledForAgent && workflow.source !== "automation")
      )
        continue;
      const block = buildWorkflowRunPrompt(
        workflow,
        { trigger: "reference" },
        this.tm.sessionStore.getUserTimeZone(),
      );
      blocks.push(
        workflow.id === "learn-from-demonstration" &&
          reference.teachQueueScope != null &&
          /^[a-f0-9]{64}$/.test(reference.teachQueueScope)
          ? `${block}\n\nTeach recording queue scope: ${reference.teachQueueScope}`
          : block,
      );
    }
    if (blocks.length === 0) return prompt;
    return prompt.length > 0
      ? `${blocks.join("\n\n")}\n\n${prompt}`
      : blocks.join("\n\n");
  }
  withMentionedAgentsContext(
    session: any,
    rawPrompt: string,
    promptForRun: string,
  ): string {
    if (rawPrompt.length === 0 || this.tm.groupChat.isGroupSession(session))
      return promptForRun;
    const roster = this.tm
      .listAgentsSync()
      .filter(
        (agent: any) =>
          agent.id !== session.id &&
          (!agent.isGroup || agent.memberIds.includes(session.id)),
      );
    const { memberIds } = parseGroupMentions(rawPrompt, roster);
    const mentioned = memberIds.flatMap((id) => {
      const agent = roster.find((candidate: any) => candidate.id === id);
      return agent == null
        ? []
        : [
            {
              id: agent.id,
              name: agent.name,
              description: agent.description,
              isGroup: agent.isGroup,
            },
          ];
    });
    const context = buildMentionedAgentsContext(mentioned);
    return context == null
      ? promptForRun
      : promptForRun.length > 0
        ? `${context}\n\n${promptForRun}`
        : context;
  }
}
