use rusqlite::{params, OptionalExtension, Row};

use crate::PultError;

use super::records::ProjectRecord;
use super::{sql, Store};

impl Store {
    pub fn create_project(&self, project: &ProjectRecord) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, name, root_path, color, worktree_strategy, pinned, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    project.id,
                    project.name,
                    project.root_path,
                    project.color,
                    project.worktree_strategy,
                    project.pinned as i64,
                    project.created_at
                ],
            )
            .map_err(|e| sql("create_project insert", e))?;
            Ok(())
        })
    }

    pub fn get_project(&self, id: &str) -> Result<ProjectRecord, PultError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, name, root_path, color, worktree_strategy, pinned, created_at
                 FROM projects WHERE id = ?1",
                [id],
                project_row,
            )
            .optional()
            .map_err(|e| sql("get_project query", e))?
            .ok_or_else(|| PultError::store(format!("project {id} not found")))
        })
    }

    /// Pinned projects first, then by creation time (stable sidebar order).
    pub fn list_projects(&self) -> Result<Vec<ProjectRecord>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, name, root_path, color, worktree_strategy, pinned, created_at
                     FROM projects ORDER BY pinned DESC, created_at ASC",
                )
                .map_err(|e| sql("list_projects prepare", e))?;
            let rows = stmt
                .query_map([], project_row)
                .map_err(|e| sql("list_projects query", e))?;
            let mut projects = Vec::new();
            for row in rows {
                projects.push(row.map_err(|e| sql("list_projects row", e))?);
            }
            Ok(projects)
        })
    }

    pub fn update_project(
        &self,
        id: &str,
        name: Option<&str>,
        color: Option<&str>,
        worktree_strategy: Option<&str>,
        pinned: Option<bool>,
    ) -> Result<ProjectRecord, PultError> {
        let mut project = self.get_project(id)?;
        if let Some(name) = name {
            project.name = name.to_string();
        }
        if let Some(color) = color {
            project.color = Some(color.to_string());
        }
        if let Some(strategy) = worktree_strategy {
            project.worktree_strategy = strategy.to_string();
        }
        if let Some(pinned) = pinned {
            project.pinned = pinned;
        }
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE projects SET name = ?2, color = ?3, worktree_strategy = ?4, pinned = ?5
                 WHERE id = ?1",
                params![
                    project.id,
                    project.name,
                    project.color,
                    project.worktree_strategy,
                    project.pinned as i64
                ],
            )
            .map_err(|e| sql("update_project", e))?;
            Ok(())
        })?;
        Ok(project)
    }

    /// Threads survive (project_id becomes NULL via the FK's ON DELETE SET NULL).
    pub fn delete_project(&self, id: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM projects WHERE id = ?1", [id])
                .map_err(|e| sql("delete_project", e))?;
            Ok(())
        })
    }
}

fn project_row(row: &Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        root_path: row.get(2)?,
        color: row.get(3)?,
        worktree_strategy: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
    })
}
