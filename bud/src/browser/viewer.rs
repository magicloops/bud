//! Typed human input. No generic CDP or script method is accepted from a viewer.
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HumanInput {
    Back,
    Click { x: f64, y: f64 },
    Scroll { x: f64, y: f64, delta_y: f64 },
    Text { focus_token: String, text: String },
    Key { focus_token: String, key: String },
}

impl HumanInput {
    pub fn valid(&self) -> bool {
        let point = |x: f64, y: f64| {
            x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 && x <= 8192.0 && y <= 8192.0
        };
        match self {
            Self::Back => true,
            Self::Click { x, y } => point(*x, *y),
            Self::Scroll { x, y, delta_y } => {
                point(*x, *y) && delta_y.is_finite() && delta_y.abs() <= 2000.0
            }
            Self::Text { focus_token, text } => {
                !focus_token.is_empty()
                    && focus_token.len() <= 128
                    && !text.is_empty()
                    && text.len() <= 8192
            }
            Self::Key { focus_token, key } => {
                !focus_token.is_empty()
                    && focus_token.len() <= 128
                    && matches!(
                        key.as_str(),
                        "Tab"
                            | "Enter"
                            | "Backspace"
                            | "Delete"
                            | "ArrowLeft"
                            | "ArrowRight"
                            | "Home"
                            | "End"
                    )
            }
        }
    }
}
