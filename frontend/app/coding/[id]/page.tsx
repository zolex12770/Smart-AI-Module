"use client";

import { use } from "react";
import TaskDetail from "../../agent/TaskDetail";
import { TaskDetailLoader } from "../../agent/task-detail-loader";

/**
 * The coding-agent view of a task. Same component, same client-side load as `/agent/[id]` —
 * see the note there for why this cannot be a server component: the fetch path reads
 * `document.cookie` and `localStorage`, so rendering it on the server threw.
 */
export default function CodingTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <TaskDetailLoader taskId={id}>
      {(task, nodes) => <TaskDetail taskId={id} initialTask={task} initialNodes={nodes} variant="coding" />}
    </TaskDetailLoader>
  );
}
