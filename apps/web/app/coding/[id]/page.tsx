import { getTask } from "../../lib/api";
import TaskDetail from "../../agent/TaskDetail";

export default async function CodingTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { task, nodes } = await getTask(id);
  return <TaskDetail taskId={id} initialTask={task} initialNodes={nodes} variant="coding" />;
}
