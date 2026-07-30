import { AppDatabase } from "./storage/database.js";
import { ProjectRepository } from "./storage/repository.js";

export interface ProjectCommandOptions {
  name?: string;
  id?: string;
  databasePath?: string;
}

export function runProjectCommand(command: string, options: ProjectCommandOptions): void {
  const database = new AppDatabase(options.databasePath);
  try {
    database.migrate();
    const repository = new ProjectRepository(database);

    if (command === "project:create") {
      if (!options.name) throw new Error("Передайте название через --name");
      const project = repository.createProject(options.name);
      console.log(JSON.stringify(project, null, 2));
      return;
    }

    if (command === "project:list") {
      const projects = repository.listProjects();
      if (projects.length === 0) {
        console.log("Проектов пока нет.");
        return;
      }
      console.table(
        projects.map(({ id, name, status, updatedAt }) => ({ id, name, status, updatedAt })),
      );
      return;
    }

    if (command === "project:open") {
      if (!options.id) throw new Error("Передайте идентификатор через --id");
      const project = repository.openProject(options.id);
      if (!project) throw new Error(`Проект не найден: ${options.id}`);
      const recoveredTurns = repository.recoverUnfinishedTurns(project.id);
      console.log(JSON.stringify({ project, recoveredTurns }, null, 2));
      return;
    }

    throw new Error(`Неизвестная команда проекта: ${command}`);
  } finally {
    database.close();
  }
}
