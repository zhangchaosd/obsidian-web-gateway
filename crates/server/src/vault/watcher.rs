use std::{path::PathBuf, sync::Arc, time::Duration};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{RwLock, broadcast, mpsc};

use crate::{
    error::{AppError, AppResult},
    index::VaultIndex,
    security::sandbox::VaultSandbox,
    websocket::GatewayEvent,
};

pub struct WatchHandle {
    _watcher: RecommendedWatcher,
}

pub fn start(
    sandbox: VaultSandbox,
    index: Arc<RwLock<VaultIndex>>,
    events: broadcast::Sender<GatewayEvent>,
) -> AppResult<WatchHandle> {
    let (sender, mut receiver) = mpsc::unbounded_channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|error| AppError::Internal(error.to_string()))?;
    watcher
        .watch(sandbox.root(), RecursiveMode::Recursive)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let sandbox = Arc::new(sandbox);

    tokio::spawn(async move {
        while let Some(first) = receiver.recv().await {
            let mut batch = vec![first];
            tokio::time::sleep(Duration::from_millis(150)).await;
            while let Ok(event) = receiver.try_recv() {
                batch.push(event);
            }

            let mut changed = false;
            for event in batch.into_iter().flatten() {
                changed = true;
                broadcast_event(&sandbox, &events, &event);
            }
            if !changed {
                continue;
            }
            let rebuild_sandbox = sandbox.clone();
            match tokio::task::spawn_blocking(move || VaultIndex::build(&rebuild_sandbox)).await {
                Ok(Ok((rebuilt, _))) => {
                    *index.write().await = rebuilt;
                    let _ = events.send(GatewayEvent {
                        kind: "index.updated".into(),
                        payload: serde_json::json!({}),
                    });
                }
                Ok(Err(error)) => {
                    tracing::warn!(error = %error, "index rebuild after filesystem event failed")
                }
                Err(error) => tracing::warn!(error = %error, "index rebuild task failed"),
            }
        }
    });
    Ok(WatchHandle { _watcher: watcher })
}

fn broadcast_event(
    sandbox: &VaultSandbox,
    sender: &broadcast::Sender<GatewayEvent>,
    event: &Event,
) {
    let visible = |path: &PathBuf| {
        path.strip_prefix(sandbox.root())
            .ok()
            .filter(|relative| sandbox.is_visible_relative(relative))
            .and_then(|_| sandbox.relative_display(path).ok())
    };
    if matches!(
        event.kind,
        EventKind::Modify(notify::event::ModifyKind::Name(_))
    ) && event.paths.len() >= 2
    {
        if let (Some(old_path), Some(new_path)) =
            (visible(&event.paths[0]), visible(&event.paths[1]))
        {
            let _ = sender.send(GatewayEvent {
                kind: "file.renamed".into(),
                payload: serde_json::json!({ "oldPath": old_path, "newPath": new_path }),
            });
        }
        return;
    }
    let kind = match event.kind {
        EventKind::Create(_) => "file.created",
        EventKind::Remove(_) => "file.deleted",
        EventKind::Modify(_) => "file.changed",
        _ => return,
    };
    for path in &event.paths {
        if let Some(path) = visible(path) {
            let _ = sender.send(GatewayEvent::path(kind, path));
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn external_change_broadcasts_and_refreshes_index() {
        let directory = tempdir().expect("temp dir");
        fs::write(directory.path().join("A.md"), "before").expect("fixture");
        let sandbox = VaultSandbox::new(directory.path(), false).expect("sandbox");
        let (initial, _) = VaultIndex::build(&sandbox).expect("index");
        let index = Arc::new(RwLock::new(initial));
        let (sender, mut receiver) = broadcast::channel(32);
        let _watcher = start(sandbox, index.clone(), sender).expect("watcher");
        tokio::time::sleep(Duration::from_millis(100)).await;

        fs::write(directory.path().join("A.md"), "external watcher content")
            .expect("external write");
        let event = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = receiver.recv().await.expect("event");
                if event.kind == "file.changed" && event.payload["path"] == "A.md" {
                    return event;
                }
            }
        })
        .await
        .expect("watch event timeout");
        assert_eq!(event.payload["path"], "A.md");

        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if !index
                    .read()
                    .await
                    .search("external watcher")
                    .expect("search")
                    .results
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("index refresh timeout");
    }
}
