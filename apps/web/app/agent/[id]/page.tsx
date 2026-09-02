import { getTask } from "../../lib/api";
import TaskDetail from "../TaskDetail";

export default async function AgentTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { task, nodes } = await getTask(id);
  return <TaskDetail taskId={id} initialTask={task} initialNodes={nodes} variant="agent" />;
}
