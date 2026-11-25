use super::{ioerr, CELL_LIMIT, ROW_LIMIT};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    params_from_iter,
    types::ValueRef,
    Connection,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, String>;

pub(super) fn restrict_sqlite(db: &Connection) -> Result<()> {
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF")
        .map_err(ioerr)?;
    db.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Read { .. } | AuthAction::Select | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if !matches!(
                function_name.to_ascii_lowercase().as_str(),
                "load_extension" | "writefile" | "eval" | "fts3_tokenizer"
            ) =>
        {
            Authorization::Allow
        }
        AuthAction::Pragma { pragma_name, .. }
            if [
                "table_info",
                "table_xinfo",
                "table_list",
                "index_list",
                "index_info",
                "foreign_key_list",
            ]
            .contains(&pragma_name) =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }));
    Ok(())
}
pub(super) fn csv_target(path: &Path, dbs: &[PathBuf]) -> Result<tempfile::NamedTempFile> {
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("csv"))
    {
        return Err("Choose an absolute CSV file path.".into());
    }
    let parent =
        std::fs::canonicalize(path.parent().ok_or("Missing destination folder")?).map_err(ioerr)?;
    let target = if path.exists() {
        std::fs::canonicalize(path).map_err(ioerr)?
    } else {
        parent.join(path.file_name().ok_or("Choose a CSV filename.")?)
    };
    let normalized = target.to_string_lossy().to_lowercase();
    for db in dbs {
        let db = db.to_string_lossy().to_lowercase();
        if ["", "-wal", "-shm", "-journal"]
            .iter()
            .any(|suffix| normalized == format!("{db}{suffix}"))
        {
            return Err("Choose a destination other than an open database file.".into());
        }
    }
    tempfile::Builder::new()
        .prefix(".vexssh-export-")
        .tempfile_in(parent)
        .map_err(ioerr)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Column {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
    primary_key: bool,
    editable: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    offset: i64,
    limit: i64,
    #[serde(default)]
    filter_column: String,
    #[serde(default)]
    filter_value: String,
    #[serde(default)]
    sort_column: String,
    #[serde(default)]
    sort_direction: String,
}
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn meta(db: &Connection, name: &str) -> Result<Vec<Column>> {
    let kind: String = db
        .query_row(
            "SELECT type FROM main.sqlite_schema WHERE name=?1 AND type IN ('view','table')",
            [name],
            |r| r.get(0),
        )
        .map_err(ioerr)?;
    let mut stmt = db
        .prepare(&format!("PRAGMA main.table_xinfo({})", quoted(name)))
        .map_err(ioerr)?;
    let rows = stmt
        .query_map([], |r| {
            let hidden: i64 = r.get(6)?;
            let pk = r.get::<_, i64>(5)? > 0;
            Ok((
                hidden,
                Column {
                    name: r.get(1)?,
                    type_name: r.get(2)?,
                    primary_key: pk,
                    editable: kind == "table" && !pk && hidden == 0,
                },
            ))
        })
        .map_err(ioerr)?;
    let mut cols = Vec::new();
    for r in rows {
        let (h, c) = r.map_err(ioerr)?;
        if h != 1 {
            cols.push(c)
        }
    }
    Ok(cols)
}
fn text(v: Option<&Value>) -> Result<Option<String>> {
    match v {
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.to_owned())),
        _ => Err("Expected a cell value or NULL.".into()),
    }
}
fn select(
    name: &str,
    cols: &[Column],
    o: &Options,
    all: bool,
    lookahead: i64,
) -> Result<(String, Vec<String>)> {
    if o.offset < 0
        || o.limit < 1
        || o.limit > ROW_LIMIT as i64
        || o.filter_value.len() > 16384
        || !["", "asc", "desc"].contains(&o.sort_direction.as_str())
    {
        return Err("Invalid table page options.".into());
    }
    let known = |name: &str| cols.iter().any(|c| c.name == name);
    let names = cols
        .iter()
        .map(|c| quoted(&c.name))
        .collect::<Vec<_>>()
        .join(",");
    let mut q = format!("SELECT {names} FROM main.{}", quoted(name));
    let mut args = vec![];
    if !o.filter_value.is_empty() {
        if !known(&o.filter_column) {
            return Err("Unknown filter column.".into());
        }
        q += &format!(
            " WHERE instr(CAST({} AS TEXT),?)>0",
            quoted(&o.filter_column)
        );
        args.push(o.filter_value.clone());
    }
    let mut order = Vec::new();
    if !o.sort_column.is_empty() {
        if !known(&o.sort_column) {
            return Err("Unknown sort column.".into());
        }
        order.push(format!(
            "{} {}",
            quoted(&o.sort_column),
            if o.sort_direction == "desc" {
                "DESC"
            } else {
                "ASC"
            }
        ));
    }
    for c in cols {
        if c.primary_key && c.name != o.sort_column {
            order.push(quoted(&c.name))
        }
    }
    if order.is_empty() {
        if let Some(c) = cols.first() {
            order.push(quoted(&c.name))
        }
    }
    if !order.is_empty() {
        q += &format!(" ORDER BY {}", order.join(","));
    }
    if !all {
        q += &format!(" LIMIT {} OFFSET {}", o.limit + lookahead, o.offset);
    }
    Ok((q, args))
}
fn cell(v: ValueRef<'_>, full: bool) -> (Option<String>, bool) {
    match v {
        ValueRef::Null => (None, false),
        ValueRef::Integer(n) => (Some(n.to_string()), false),
        ValueRef::Real(n) => (Some(n.to_string()), false),
        ValueRef::Text(t) => {
            let bytes = if full {
                t
            } else {
                &t[..t.len().min(CELL_LIMIT)]
            };
            let is_lossy = std::str::from_utf8(bytes).is_err();
            let mut s = String::from_utf8_lossy(bytes).into_owned();
            if bytes.len() != t.len() {
                s.push('…')
            };
            (Some(s), is_lossy || bytes.len() != t.len())
        }
        ValueRef::Blob(b) => {
            if full {
                use std::fmt::Write;
                let mut s = String::from("0x");
                for v in b {
                    let _ = write!(s, "{v:02x}");
                }
                (Some(s), true)
            } else {
                (Some(format!("[{} bytes]", b.len())), true)
            }
        }
    }
}
fn csv_record(w: &mut impl Write, values: impl IntoIterator<Item = String>) -> Result<()> {
    for (i, s) in values.into_iter().enumerate() {
        if i > 0 {
            w.write_all(b",").map_err(ioerr)?
        };
        w.write_all(b"\"").map_err(ioerr)?;
        w.write_all(s.replace('"', "\"\"").as_bytes())
            .map_err(ioerr)?;
        w.write_all(b"\"").map_err(ioerr)?;
    }
    w.write_all(b"\r\n").map_err(ioerr)
}
pub(super) fn execute(db: &mut Connection, p: &Value) -> Result<Value> {
    let object = &p["object"];
    if object["schema"] != "main" {
        return Err("Choose an object in the main SQLite database.".into());
    }
    let name = object["name"].as_str().ok_or("Missing table")?;
    if name.contains('\0') {
        return Err("Invalid table name.".into());
    }
    if p["action"] == "update" {
        return update(db, p, name);
    }
    let cols = meta(db, name)?;
    let opts: Options = serde_json::from_value(p.clone()).map_err(ioerr)?;
    let export = p["action"] == "export";
    if export && p["scope"] != "all" && p["scope"] != "page" {
        return Err("Choose an export scope.".into());
    }
    let (q, args) = select(
        name,
        &cols,
        &opts,
        export && p["scope"] == "all",
        i64::from(!export),
    )?;
    let mut stmt = db.prepare(&q).map_err(ioerr)?;
    let mut cursor = stmt.query(params_from_iter(&args)).map_err(ioerr)?;
    if export {
        let file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(p["path"].as_str().ok_or("Missing export destination")?)
            .map_err(ioerr)?;
        let mut w = BufWriter::new(file);
        csv_record(&mut w, cols.iter().map(|c| c.name.clone()))?;
        let mut count = 0;
        while let Some(row) = cursor.next().map_err(ioerr)? {
            let mut values = Vec::new();
            for i in 0..cols.len() {
                values.push(
                    cell(row.get_ref(i).map_err(ioerr)?, true)
                        .0
                        .unwrap_or_default(),
                )
            }
            csv_record(&mut w, values)?;
            count += 1;
        }
        w.flush().map_err(ioerr)?;
        w.get_ref().sync_all().map_err(ioerr)?;
        return Ok(json!({"rows":count}));
    }
    let (mut rows, mut edits, mut more, mut clipped, mut size) =
        (Vec::new(), Vec::new(), false, false, 0usize);
    while let Some(row) = cursor.next().map_err(ioerr)? {
        if rows.len() == opts.limit as usize {
            more = true;
            break;
        }
        let mut cells = Vec::new();
        let mut editable = cols.iter().any(|c| c.primary_key);
        for (i, c) in cols.iter().enumerate() {
            let raw = row.get_ref(i).map_err(ioerr)?;
            let (v, clip) = cell(raw, false);
            if matches!(raw, ValueRef::Blob(_)) || clip || c.primary_key && v.is_none() {
                editable = false;
            }
            clipped |= clip;
            size += 5 + v.as_ref().map_or(0, String::len);
            cells.push(v);
        }
        if size > 1 << 20 {
            if rows.is_empty() {
                return Err(
                    "Row too large to preview. Select fewer columns in the SQL editor.".into(),
                );
            };
            more = true;
            break;
        }
        rows.push(cells);
        edits.push(editable);
    }
    Ok(
        json!({"columns":cols.iter().map(|c|&c.name).collect::<Vec<_>>(),"rows":rows,"metadata":cols,"editableRows":edits,"truncated":clipped,"hasMore":more}),
    )
}
fn update(db: &mut Connection, p: &Value, name: &str) -> Result<Value> {
    // A savepoint composes with a transaction the editor already opened.
    let tx = db.savepoint().map_err(ioerr)?;
    let columns = meta(&tx, name)?;
    let column = p["column"].as_str().ok_or("Missing column")?;
    if !columns.iter().any(|c| c.name == column && c.editable) {
        return Err("Choose an editable column.".into());
    }
    let keys = p["key"].as_object().ok_or("Missing primary key")?;
    let pk = columns.iter().filter(|c| c.primary_key).collect::<Vec<_>>();
    if pk.is_empty() || pk.len() != keys.len() {
        return Err("A complete primary key is required.".into());
    }
    let mut conditions = Vec::new();
    let mut params = Vec::<Option<String>>::new();
    for c in pk {
        let v = keys
            .get(&c.name)
            .and_then(Value::as_str)
            .ok_or("Invalid primary key")?;
        conditions.push(format!("{} = ?", quoted(&c.name)));
        params.push(Some(v.to_owned()));
    }
    let table = quoted(name);
    let col = quoted(column);
    let where_clause = conditions.join(" AND ");
    let old = text(p.get("oldValue"))?;
    let new = text(p.get("newValue"))?;
    let (current, unsafe_value) = tx
        .query_row(
            &format!("SELECT {col} FROM main.{table} WHERE {where_clause}"),
            params_from_iter(&params),
            |r| Ok(cell(r.get_ref(0)?, false)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                "This row was removed. Refresh before editing.".into()
            }
            _ => e.to_string(),
        })?;
    if unsafe_value || current != old {
        return Err("This cell changed since the preview. Refresh before editing.".into());
    }
    params.insert(0, new);
    let count = tx
        .execute(
            &format!("UPDATE main.{table} SET {col}=? WHERE {where_clause}"),
            params_from_iter(&params),
        )
        .map_err(ioerr)?;
    if count != 1 {
        return Err("The change must affect exactly one row.".into());
    };
    tx.commit().map_err(ioerr)?;
    Ok(json!({"affected":1}))
}
