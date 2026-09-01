use axum::extract::{
    State, WebSocketUpgrade,
    ws::{Message, WebSocket},
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::app::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct GatewayEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

impl GatewayEvent {
    pub fn path(kind: &str, path: String) -> Self {
        Self {
            kind: kind.into(),
            payload: serde_json::json!({ "path": path }),
        }
    }
}

pub async fn ws_handler(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> impl axum::response::IntoResponse {
    upgrade
        .max_message_size(64 * 1024)
        .on_upgrade(move |socket| client(socket, state.events.subscribe()))
}

async fn client(socket: WebSocket, mut receiver: broadcast::Receiver<GatewayEvent>) {
    let (mut sender, mut incoming) = socket.split();
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Ok(event) => {
                    let Ok(json) = serde_json::to_string(&event) else { continue; };
                    if sender.send(Message::Text(json.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let event = GatewayEvent { kind: "index.updated".into(), payload: serde_json::json!({ "reason": "lagged" }) };
                    let Ok(json) = serde_json::to_string(&event) else { continue; };
                    if sender.send(Message::Text(json.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            message = incoming.next() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}
