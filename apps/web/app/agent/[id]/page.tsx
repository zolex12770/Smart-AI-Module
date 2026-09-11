"use client";

import { use } from "react";
import TaskDetail from "../TaskDetail";
import { TaskDetailLoader } from "../task-detail-loader";

/**
 * A client component, like every other screen in this app — it was the last server component
 * left and it could not work as one.
 *
 * As a server component this page ran `getTask(id)` during the server render. That call goes
 * `getTask` → `request` → `apiFetch`, which lives in a `"use client"` module and reads
 * `document.cookie` for the CSRF token and `window.localStorage` for the selected project.
 * Neither exists on the server, so the render threw before the page ever reached the browser:
 * the route was a hard error, not a degraded screen. Even if it had not thrown, the session
 * cookie the request needs is held by the browser and was never on that server-side fetch.
 */
export default function AgentTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <TaskDetailLoader taskId={id}>
      {(task, nodes) => <TaskDetail taskId={id} initialTask={task} initialNodes={nodes} variant="agent" />}
    </TaskDetailLoader>
  );
}
