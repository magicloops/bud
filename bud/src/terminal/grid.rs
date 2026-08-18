//! Grid-sync wire serialization: `stem::GridFrame` → the `terminal_grid`
//! frame's payload fields (docs/proto.md §6.8, plan/terminal-grid-sync
//! implementation-spec §2/§4).
//!
//! Run encoding: `{"t": text}` with `fg`/`bg`/`a` omitted when default.
//! Colors: palette index as a bare number (0–15 named, 16–255 indexed),
//! truecolor as `[r, g, b]`. Attrs: bitfield (1 bold, 2 dim, 4 italic,
//! 8 underline, 16 inverse, 32 strikeout) — stem's `cell_attrs` values.

use serde_json::{json, Map, Number, Value};

use stem::emu::{CellColor, CursorShapeKind, MouseReport, StyledRun};
use stem::session::GridFrame;

fn color_value(color: CellColor) -> Value {
    match color {
        CellColor::Indexed(index) => Value::Number(Number::from(index)),
        CellColor::Rgb(r, g, b) => json!([r, g, b]),
    }
}

fn run_value(run: &StyledRun) -> Value {
    let mut map = Map::new();
    map.insert("t".into(), Value::String(run.text.clone()));
    if let Some(fg) = run.fg {
        map.insert("fg".into(), color_value(fg));
    }
    if let Some(bg) = run.bg {
        map.insert("bg".into(), color_value(bg));
    }
    if run.attrs != 0 {
        map.insert("a".into(), Value::Number(Number::from(run.attrs)));
    }
    Value::Object(map)
}

fn runs_value(runs: &[StyledRun]) -> Value {
    Value::Array(runs.iter().map(run_value).collect())
}

/// Payload fields of a `terminal_grid` frame (envelope + `session_id` are
/// added by [`crate::protocol::terminal_grid_frame`]).
pub(crate) fn grid_frame_fields(frame: &GridFrame) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert(
        "generation".into(),
        Value::Number(Number::from(frame.generation)),
    );
    fields.insert("full".into(), Value::Bool(frame.full));
    fields.insert("cols".into(), Value::Number(Number::from(frame.cols)));
    fields.insert("rows".into(), Value::Number(Number::from(frame.rows)));
    fields.insert("alt_screen".into(), Value::Bool(frame.alt_screen));
    if frame.row_shift != 0 {
        // Scroll-hint (§6.8.5): shift-then-patch delta; omitted when zero.
        fields.insert(
            "row_shift".into(),
            Value::Number(Number::from(frame.row_shift)),
        );
    }
    fields.insert(
        "cursor".into(),
        json!({
            "row": frame.cursor.row,
            "col": frame.cursor.col,
            "visible": frame.cursor.visible,
            "shape": match frame.cursor_shape {
                CursorShapeKind::Block => "block",
                CursorShapeKind::Underline => "underline",
                CursorShapeKind::Beam => "beam",
            },
            "blink": frame.cursor_blink,
        }),
    );
    fields.insert(
        "mouse".into(),
        json!({
            "report": match frame.mouse.report {
                MouseReport::None => "none",
                MouseReport::Click => "click",
                MouseReport::Drag => "drag",
                MouseReport::Motion => "motion",
            },
            "sgr": frame.mouse.sgr,
            "alt_scroll": frame.mouse.alt_scroll,
        }),
    );
    fields.insert("app_cursor".into(), Value::Bool(frame.app_cursor));
    fields.insert(
        "dirty_rows".into(),
        Value::Array(
            frame
                .dirty_rows
                .iter()
                .map(|row| {
                    json!({
                        "row": row.row,
                        "runs": runs_value(&row.runs),
                    })
                })
                .collect(),
        ),
    );
    fields.insert(
        "scrollback_push".into(),
        Value::Array(
            frame
                .scrollback_push
                .iter()
                .map(|line| runs_value(line))
                .collect(),
        ),
    );
    fields.insert(
        "scrollback_dropped".into(),
        Value::Number(Number::from(frame.scrollback_dropped)),
    );
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use stem::emu::{cell_attrs, CursorPos};
    use stem::session::GridRow;

    #[test]
    fn frame_serialization_shape() {
        let frame = GridFrame {
            generation: 7,
            full: false,
            cols: 80,
            rows: 24,
            alt_screen: false,
            cursor: CursorPos {
                row: 3,
                col: 9,
                visible: true,
            },
            row_shift: 3,
            cursor_shape: CursorShapeKind::Beam,
            cursor_blink: true,
            mouse: stem::emu::MouseModes {
                report: MouseReport::Drag,
                sgr: true,
                alt_scroll: false,
            },
            app_cursor: true,
            dirty_rows: vec![GridRow {
                row: 3,
                runs: vec![
                    StyledRun {
                        text: "plain ".into(),
                        fg: None,
                        bg: None,
                        attrs: 0,
                    },
                    StyledRun {
                        text: "red".into(),
                        fg: Some(CellColor::Indexed(1)),
                        bg: Some(CellColor::Rgb(10, 20, 30)),
                        attrs: cell_attrs::BOLD | cell_attrs::UNDERLINE,
                    },
                ],
            }],
            scrollback_push: vec![vec![StyledRun {
                text: "old line".into(),
                fg: None,
                bg: None,
                attrs: 0,
            }]],
            scrollback_dropped: 0,
        };

        let fields = Value::Object(grid_frame_fields(&frame));
        assert_eq!(fields["generation"], 7);
        assert_eq!(fields["full"], false);
        assert_eq!(fields["cursor"]["col"], 9);
        assert_eq!(fields["cursor"]["shape"], "beam");
        assert_eq!(fields["cursor"]["blink"], true);
        assert_eq!(
            fields["mouse"],
            json!({ "report": "drag", "sgr": true, "alt_scroll": false })
        );
        assert_eq!(fields["app_cursor"], true);
        assert_eq!(fields["row_shift"], 3);
        let runs = &fields["dirty_rows"][0]["runs"];
        // Default style omits every style key.
        assert_eq!(runs[0], json!({ "t": "plain " }));
        assert_eq!(
            runs[1],
            json!({ "t": "red", "fg": 1, "bg": [10, 20, 30], "a": 9 })
        );
        assert_eq!(fields["scrollback_push"][0][0], json!({ "t": "old line" }));
        assert_eq!(fields["scrollback_dropped"], 0);
    }
}
