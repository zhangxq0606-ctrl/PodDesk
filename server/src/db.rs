use crate::model::*;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
        -- In WAL mode NORMAL is still crash-safe, and commits stop waiting on a disk flush each time.
        PRAGMA synchronous=NORMAL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS shows(
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, author TEXT, cover TEXT,
            feed_url TEXT NOT NULL, link TEXT, description TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS episodes(
            id TEXT PRIMARY KEY, show_id TEXT NOT NULL, guid TEXT NOT NULL, title TEXT NOT NULL,
            published INTEGER, duration REAL, audio_url TEXT, video_id TEXT, link TEXT, cover TEXT, notes TEXT,
            transcript_url TEXT, transcript_type TEXT, progress REAL NOT NULL DEFAULT 0, touched_at INTEGER,
            completed INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS episodes_show ON episodes(show_id, published DESC);
        CREATE INDEX IF NOT EXISTS episodes_published ON episodes(published DESC);
        CREATE TABLE IF NOT EXISTS transcripts(
            episode_id TEXT PRIMARY KEY, source TEXT NOT NULL, language TEXT NOT NULL, segments TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS blobs(
            episode_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(episode_id, kind));
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tr_cache(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS listens(day TEXT NOT NULL, hour INTEGER NOT NULL, episode_id TEXT NOT NULL, show_id TEXT NOT NULL,
            seconds REAL NOT NULL, translated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, hour, episode_id));",
    )?;
    let cols: Vec<String> = {
        let mut st = conn.prepare("PRAGMA table_info(episodes)")?;
        let out = st
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        out
    };
    if !cols.iter().any(|c| c == "touched_at") {
        conn.execute("ALTER TABLE episodes ADD COLUMN touched_at INTEGER", [])?;
    }
    if !cols.iter().any(|c| c == "completed") {
        conn.execute_batch(
            "ALTER TABLE episodes ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
             UPDATE episodes SET completed = 1 WHERE duration IS NOT NULL AND duration > 0 AND progress >= duration * 0.97;",
        )?;
    }
    conn.execute("CREATE INDEX IF NOT EXISTS episodes_touched ON episodes(touched_at DESC)", [])?;
    conn.execute("CREATE INDEX IF NOT EXISTS episodes_show_completed ON episodes(show_id, completed)", [])?;
    Ok(conn)
}

pub fn upsert_show(conn: &Connection, s: &Show) -> Result<()> {
    conn.execute(
        "INSERT INTO shows(id,kind,title,author,cover,feed_url,link,description,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author, cover=COALESCE(excluded.cover, shows.cover),
         link=excluded.link, description=excluded.description, updated_at=excluded.updated_at",
        params![s.id, s.kind, s.title, s.author, s.cover, s.feed_url, s.link, s.description, s.updated_at],
    )?;
    Ok(())
}

pub fn upsert_episodes(conn: &mut Connection, eps: &[Episode]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare(
            "INSERT INTO episodes(id,show_id,guid,title,published,duration,audio_url,video_id,link,cover,notes,transcript_url,transcript_type,touched_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, published=COALESCE(excluded.published, episodes.published), duration=COALESCE(excluded.duration, episodes.duration),
             audio_url=COALESCE(excluded.audio_url, episodes.audio_url), link=excluded.link, cover=COALESCE(excluded.cover, episodes.cover),
             notes=COALESCE(excluded.notes, episodes.notes), transcript_url=excluded.transcript_url, transcript_type=excluded.transcript_type,
             touched_at=COALESCE(excluded.touched_at, episodes.touched_at)",
        )?;
        for e in eps {
            st.execute(params![
                e.id, e.show_id, e.guid, e.title, e.published, e.duration, e.audio_url, e.video_id, e.link, e.cover, e.notes,
                e.transcript_url, e.transcript_type, e.touched_at
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Inserts older/paginated episodes while preserving any existing precise `published` timestamp,
/// and returns how many brand-new rows were inserted.
pub fn upsert_older_episodes(conn: &mut Connection, eps: &[Episode]) -> Result<usize> {
    let tx = conn.transaction()?;
    let mut added = 0usize;
    {
        let mut exists_st = tx.prepare("SELECT 1 FROM episodes WHERE id=?1")?;
        let mut st = tx.prepare(
            "INSERT INTO episodes(id,show_id,guid,title,published,duration,audio_url,video_id,link,cover,notes,transcript_url,transcript_type,touched_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, published=COALESCE(episodes.published, excluded.published), duration=COALESCE(excluded.duration, episodes.duration),
             audio_url=COALESCE(episodes.audio_url, excluded.audio_url), link=COALESCE(excluded.link, episodes.link), cover=COALESCE(excluded.cover, episodes.cover),
             notes=COALESCE(episodes.notes, excluded.notes)",
        )?;
        for e in eps {
            let existed = exists_st.exists([&e.id])?;
            if !existed {
                added += 1;
            }
            st.execute(params![
                e.id, e.show_id, e.guid, e.title, e.published, e.duration, e.audio_url, e.video_id, e.link, e.cover, e.notes,
                e.transcript_url, e.transcript_type, e.touched_at
            ])?;
        }
    }
    tx.commit()?;
    Ok(added)
}

fn show_from(r: &rusqlite::Row) -> rusqlite::Result<Show> {
    Ok(Show {
        id: r.get(0)?, kind: r.get(1)?, title: r.get(2)?, author: r.get(3)?, cover: r.get(4)?, feed_url: r.get(5)?,
        link: r.get(6)?, description: r.get(7)?, updated_at: r.get(8)?, unplayed: r.get(9).unwrap_or(0),
    })
}

pub fn list_shows(conn: &Connection) -> Result<Vec<Show>> {
    let since = now_ms() - 7 * 86_400_000;
    let mut st = conn.prepare(
        "SELECT s.id,s.kind,s.title,s.author,s.cover,s.feed_url,s.link,s.description,s.updated_at,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id=s.id AND e.completed=0 AND e.published >= ?1) FROM shows s WHERE s.kind != 'single' ORDER BY s.title COLLATE NOCASE",
    )?;
    let rows = st.query_map([since], show_from)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_show(conn: &Connection, id: &str) -> Result<Option<Show>> {
    Ok(conn
        .query_row("SELECT id,kind,title,author,cover,feed_url,link,description,updated_at,0 FROM shows WHERE id=?1", [id], show_from)
        .optional()?)
}

pub fn delete_show(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM episodes WHERE show_id=?1 AND id NOT IN (SELECT episode_id FROM transcripts)", [id])?;
    conn.execute("DELETE FROM shows WHERE id=?1", [id])?;
    Ok(())
}

const EPISODE_COLS: &str = "e.id,e.show_id,e.guid,e.title,e.published,e.duration,e.audio_url,e.video_id,e.link,e.cover,e.notes,e.transcript_url,e.transcript_type,e.progress,
    EXISTS(SELECT 1 FROM transcripts t WHERE t.episode_id=e.id), s.title, e.touched_at, e.completed";

/// The same columns without show notes, which are large and lists don't show.
fn list_cols() -> String { EPISODE_COLS.replacen("e.notes", "NULL", 1) }

#[allow(dead_code)]
pub fn show_notes(conn: &Connection, show_id: &str) -> Result<HashMap<String, String>> {
    let mut st = conn.prepare("SELECT id, notes FROM episodes WHERE show_id=?1 AND notes IS NOT NULL")?;
    let rows = st.query_map([show_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn episode_from(r: &rusqlite::Row) -> rusqlite::Result<Episode> {
    Ok(Episode {
        id: r.get(0)?, show_id: r.get(1)?, guid: r.get(2)?, title: r.get(3)?, published: r.get(4)?, duration: r.get(5)?,
        audio_url: r.get(6)?, video_id: r.get(7)?, link: r.get(8)?, cover: r.get(9)?, notes: r.get(10)?,
        transcript_url: r.get(11)?, transcript_type: r.get(12)?, progress: r.get(13)?, has_transcript: r.get(14)?, show_title: r.get(15)?,
        touched_at: r.get(16)?,
        completed: r.get::<_, i64>(17).unwrap_or(0) != 0,
    })
}

pub fn list_episodes(conn: &Connection, show_id: Option<&str>, limit: i64) -> Result<Vec<Episode>> {
    let sql = format!(
        "SELECT {} FROM episodes e LEFT JOIN shows s ON s.id=e.show_id {} ORDER BY COALESCE(e.published, 0) DESC, e.rowid ASC LIMIT ?1",
        list_cols(),
        if show_id.is_some() { "WHERE e.show_id=?2" } else { "WHERE s.kind != 'single'" }
    );
    let mut st = conn.prepare(&sql)?;
    let map = |r: &rusqlite::Row| episode_from(r).map(|mut e| { e.notes = None; e });
    let rows = match show_id {
        Some(id) => st.query_map(params![limit, id], map)?.collect::<rusqlite::Result<Vec<_>>>()?,
        None => st.query_map(params![limit], map)?.collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok(rows)
}

pub fn recent_episodes(conn: &Connection, limit: i64) -> Result<Vec<Episode>> {
    let sql = format!(
        "SELECT {} FROM episodes e LEFT JOIN shows s ON s.id=e.show_id
         WHERE e.progress > 0 OR EXISTS(SELECT 1 FROM transcripts t WHERE t.episode_id=e.id) OR e.show_id='single' OR s.kind='single'
         ORDER BY COALESCE(e.touched_at, e.published, 0) DESC, e.rowid DESC LIMIT ?1",
        list_cols()
    );
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params![limit], |r| episode_from(r).map(|mut e| { e.notes = None; e }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_episode(conn: &Connection, id: &str) -> Result<Option<Episode>> {
    let sql = format!("SELECT {EPISODE_COLS} FROM episodes e LEFT JOIN shows s ON s.id=e.show_id WHERE e.id=?1");
    Ok(conn.query_row(&sql, [id], episode_from).optional()?)
}

pub fn delete_episode(conn: &Connection, id: &str) -> Result<Option<String>> {
    let audio_url: Option<Option<String>> = conn
        .query_row("SELECT audio_url FROM episodes WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    let Some(audio) = audio_url else {
        return Ok(None);
    };
    conn.execute("DELETE FROM transcripts WHERE episode_id=?1", [id])?;
    conn.execute("DELETE FROM blobs WHERE episode_id=?1", [id])?;
    conn.execute("DELETE FROM listens WHERE episode_id=?1", [id])?;
    conn.execute("DELETE FROM episodes WHERE id=?1", [id])?;
    Ok(Some(audio.unwrap_or_default()))
}

#[allow(dead_code)]
pub fn set_audio_url(conn: &Connection, id: &str, url: &str) -> Result<()> {
    conn.execute("UPDATE episodes SET audio_url=?2 WHERE id=?1", params![id, url])?;
    Ok(())
}

pub fn set_progress(conn: &Connection, id: &str, seconds: f64) -> Result<bool> {
    let row: Option<(Option<f64>, i64)> = conn
        .query_row("SELECT duration, completed FROM episodes WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let auto_done = row
        .as_ref()
        .and_then(|(dur, _)| *dur)
        .is_some_and(|d| d > 0.0 && seconds >= d * 0.97);
    let next_completed = row.as_ref().is_some_and(|(_, c)| *c != 0) || auto_done;
    conn.execute(
        "UPDATE episodes SET progress=?2, touched_at=?3, completed=MAX(completed, ?4) WHERE id=?1",
        params![id, seconds.max(0.01), now_ms(), if auto_done { 1 } else { 0 }],
    )?;
    Ok(next_completed)
}

pub fn set_completed(conn: &Connection, id: &str, completed: bool) -> Result<Option<Episode>> {
    let row: Option<(Option<f64>, f64)> = conn
        .query_row("SELECT duration, progress FROM episodes WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((duration, progress)) = row else {
        return Ok(None);
    };
    let now = now_ms();
    if completed {
        conn.execute("UPDATE episodes SET completed=1, touched_at=?2 WHERE id=?1", params![id, now])?;
    } else if duration.is_some_and(|d| d > 0.0 && progress >= d * 0.97) {
        conn.execute(
            "UPDATE episodes SET completed=0, progress=0, touched_at=?2 WHERE id=?1",
            params![id, now],
        )?;
    } else {
        conn.execute("UPDATE episodes SET completed=0, touched_at=?2 WHERE id=?1", params![id, now])?;
    }
    get_episode(conn, id)
}

pub fn mark_show_completed(conn: &Connection, show_id: &str) -> Result<usize> {
    let updated = conn.execute(
        "UPDATE episodes SET completed=1 WHERE show_id=?1 AND completed=0",
        [show_id],
    )?;
    Ok(updated)
}

pub fn touch_episode(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("UPDATE episodes SET touched_at=?2 WHERE id=?1", params![id, now_ms()])?;
    Ok(())
}

pub fn update_episode_published(conn: &Connection, id: &str, published: Option<i64>) -> Result<()> {
    conn.execute("UPDATE episodes SET published=?2 WHERE id=?1", params![id, published])?;
    Ok(())
}

pub fn save_transcript(conn: &Connection, t: &Transcript) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO transcripts(episode_id,source,language,segments,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![t.episode_id, t.source, t.language, serde_json::to_string(&t.segments)?, now_ms()],
    )?;
    // A new transcript invalidates translations and summaries made from the old one.
    conn.execute("DELETE FROM blobs WHERE episode_id=?1 AND kind NOT IN ('chat', 'chat-archive', 'notes-full', 'ctx')", [&t.episode_id])?;
    Ok(())
}

pub fn get_transcript(conn: &Connection, id: &str) -> Result<Option<Transcript>> {
    let row: Option<(String, String, String)> = conn
        .query_row("SELECT source,language,segments FROM transcripts WHERE episode_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    Ok(match row {
        Some((source, language, segs)) => Some(Transcript { episode_id: id.to_string(), source, language, segments: serde_json::from_str(&segs)? }),
        None => None,
    })
}

pub fn get_blob(conn: &Connection, id: &str, kind: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT data FROM blobs WHERE episode_id=?1 AND kind=?2", [id, kind], |r| r.get(0)).optional()?)
}

pub fn set_blob(conn: &Connection, id: &str, kind: &str, data: &str) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO blobs(episode_id,kind,data) VALUES(?1,?2,?3)", params![id, kind, data])?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)", params![key, value])?;
    Ok(())
}

pub fn list_settings(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut st = conn.prepare("SELECT key, value FROM settings")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(rows)
}

pub fn tr_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM tr_cache WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

pub fn tr_put(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO tr_cache(key,value) VALUES(?1,?2)", params![key, value])?;
    Ok(())
}

#[allow(dead_code)]
pub fn log_listen(conn: &Connection, episode_id: &str, show_id: &str, seconds: f64, translated: bool) -> Result<()> {
    let now = chrono::Local::now();
    conn.execute(
        "INSERT INTO listens(day,hour,episode_id,show_id,seconds,translated) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(day,hour,episode_id) DO UPDATE SET seconds = seconds + excluded.seconds, translated = MAX(translated, excluded.translated)",
        params![now.format("%Y-%m-%d").to_string(), now.format("%H").to_string().parse::<i64>().unwrap_or(0), episode_id, show_id, seconds.clamp(0.0, 120.0), translated as i64],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn listens_since(conn: &Connection, since: &str) -> Result<Vec<serde_json::Value>> {
    let mut st = conn.prepare(
        "SELECT l.day, l.hour, l.episode_id, l.show_id, l.seconds, l.translated, COALESCE(s.title,''), COALESCE(s.kind,''), COALESCE(s.cover,''), COALESCE(e.title,''), COALESCE(e.video_id,''),
                COALESCE(e.duration,0), COALESCE(e.progress,0), COALESCE(e.published,0)
         FROM listens l LEFT JOIN shows s ON s.id = l.show_id LEFT JOIN episodes e ON e.id = l.episode_id WHERE l.day >= ?1 ORDER BY l.day")?;
    let rows = st.query_map([since], |r| Ok(serde_json::json!({
        "day": r.get::<_, String>(0)?, "hour": r.get::<_, i64>(1)?, "episodeId": r.get::<_, String>(2)?, "showId": r.get::<_, String>(3)?,
        "seconds": r.get::<_, f64>(4)?, "translated": r.get::<_, i64>(5)? == 1, "showTitle": r.get::<_, String>(6)?, "kind": r.get::<_, String>(7)?,
        "cover": r.get::<_, String>(8)?, "episodeTitle": r.get::<_, String>(9)?, "video": !r.get::<_, String>(10)?.is_empty(),
        "duration": r.get::<_, f64>(11)?, "progress": r.get::<_, f64>(12)?, "published": r.get::<_, i64>(13)?,
    })))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_seven_tables_and_round_trips_core_entities() {
        let path = std::env::temp_dir().join(format!("podcast-desk-db-test-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);

        {
            let mut conn = open(&path).unwrap();
            let tables: Vec<String> = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            for expected in ["shows", "episodes", "transcripts", "blobs", "settings", "tr_cache", "listens"] {
                assert!(tables.contains(&expected.to_string()), "missing table {expected}");
            }

            let show = Show {
                id: "show-1".into(),
                kind: "podcast".into(),
                title: "Test Show".into(),
                feed_url: "https://example.com/feed.xml".into(),
                updated_at: 100,
                ..Default::default()
            };
            upsert_show(&conn, &show).unwrap();
            assert_eq!(list_shows(&conn).unwrap().len(), 1);

            let ep = Episode {
                id: "ep-1".into(),
                show_id: "show-1".into(),
                guid: "guid-1".into(),
                title: "Episode One".into(),
                published: Some(200),
                ..Default::default()
            };
            upsert_episodes(&mut conn, std::slice::from_ref(&ep)).unwrap();
            set_progress(&conn, "ep-1", 42.5).unwrap();

            let tr = Transcript {
                episode_id: "ep-1".into(),
                source: "rss".into(),
                language: "en".into(),
                segments: vec![Segment { start: 0.0, end: 3.5, text: "Hello world".into() }],
            };
            save_transcript(&conn, &tr).unwrap();

            let loaded_ep = get_episode(&conn, "ep-1").unwrap().unwrap();
            assert!(loaded_ep.has_transcript);
            assert_eq!(loaded_ep.progress, 42.5);
            assert_eq!(get_transcript(&conn, "ep-1").unwrap().unwrap().segments, tr.segments);

            set_blob(&conn, "ep-1", "chat", r#"[{"role":"user","content":"hi"}]"#).unwrap();
            assert!(get_blob(&conn, "ep-1", "chat").unwrap().is_some());

            set_setting(&conn, "proxy", "http://127.0.0.1:7890").unwrap();
            assert_eq!(get_setting(&conn, "proxy").unwrap().as_deref(), Some("http://127.0.0.1:7890"));
            assert_eq!(list_settings(&conn).unwrap().get("proxy").map(String::as_str), Some("http://127.0.0.1:7890"));
        }

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn deletes_episode_and_related_records() {
        let path = std::env::temp_dir().join(format!("podcast-desk-del-test-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);

        {
            let mut conn = open(&path).unwrap();
            let ep = Episode {
                id: "ep-del".into(),
                show_id: "single".into(),
                guid: "guid-del".into(),
                title: "Delete Me".into(),
                audio_url: Some("/api/media/ep-del.mp3".into()),
                ..Default::default()
            };
            upsert_episodes(&mut conn, std::slice::from_ref(&ep)).unwrap();
            let tr = Transcript {
                episode_id: "ep-del".into(),
                source: "import".into(),
                language: "zh".into(),
                segments: vec![Segment { start: 0.0, end: 2.0, text: "hello".into() }],
            };
            save_transcript(&conn, &tr).unwrap();
            set_blob(&conn, "ep-del", "chat", "[]").unwrap();

            assert_eq!(delete_episode(&conn, "missing").unwrap(), None);
            assert_eq!(delete_episode(&conn, "ep-del").unwrap().as_deref(), Some("/api/media/ep-del.mp3"));
            assert!(get_episode(&conn, "ep-del").unwrap().is_none());
            assert!(get_transcript(&conn, "ep-del").unwrap().is_none());
            assert!(get_blob(&conn, "ep-del", "chat").unwrap().is_none());
        }

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn migrates_legacy_episodes_table_with_touched_at() {
        let path = std::env::temp_dir().join(format!("podcast-desk-mig-test-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);

        {
            let legacy = Connection::open(&path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE episodes(
                        id TEXT PRIMARY KEY, show_id TEXT NOT NULL, guid TEXT NOT NULL, title TEXT NOT NULL,
                        published INTEGER, duration REAL, audio_url TEXT, video_id TEXT, link TEXT, cover TEXT, notes TEXT,
                        transcript_url TEXT, transcript_type TEXT, progress REAL NOT NULL DEFAULT 0);
                     INSERT INTO episodes(id,show_id,guid,title,published) VALUES('ep-old','single','g-old','Old Video',1000);
                     INSERT INTO episodes(id,show_id,guid,title,published) VALUES('ep-new','single','g-new','Newer Video',2000);",
                )
                .unwrap();
        }

        {
            let conn = open(&path).unwrap();
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(episodes)")
                .unwrap()
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            assert!(cols.iter().any(|c| c == "touched_at"));

            touch_episode(&conn, "ep-old").unwrap();
            let recent = recent_episodes(&conn, 10).unwrap();
            assert_eq!(recent[0].id, "ep-old");
            assert!(recent[0].touched_at.is_some());
        }

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn migrates_legacy_episodes_with_completed_and_unplayed_count() {
        let path = std::env::temp_dir().join(format!("podcast-desk-comp-test-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let now = now_ms();
        {
            let legacy = Connection::open(&path).unwrap();
            let recent_1 = now - 3_600_000;
            let recent_2 = now - 7_200_000;
            let recent_3 = now - 10_800_000;
            let old_30d = now - 30 * 86_400_000;
            legacy
                .execute_batch(&format!(
                    "CREATE TABLE shows(
                        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, author TEXT, cover TEXT,
                        feed_url TEXT NOT NULL, link TEXT, description TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
                     CREATE TABLE episodes(
                        id TEXT PRIMARY KEY, show_id TEXT NOT NULL, guid TEXT NOT NULL, title TEXT NOT NULL,
                        published INTEGER, duration REAL, audio_url TEXT, video_id TEXT, link TEXT, cover TEXT, notes TEXT,
                        transcript_url TEXT, transcript_type TEXT, progress REAL NOT NULL DEFAULT 0);
                     INSERT INTO shows(id,kind,title,feed_url,updated_at) VALUES('s1','podcast','Show 1','https://x/rss',1);
                     INSERT INTO episodes(id,show_id,guid,title,published,duration,progress) VALUES('e-done','s1','g1','Done',{recent_1},100.0,98.0);
                     INSERT INTO episodes(id,show_id,guid,title,published,duration,progress) VALUES('e-mid','s1','g2','Mid',{recent_2},100.0,20.0);
                     INSERT INTO episodes(id,show_id,guid,title,published,duration,progress) VALUES('e-null','s1','g3','NoDur',{recent_3},NULL,0.0);
                     INSERT INTO episodes(id,show_id,guid,title,published,duration,progress) VALUES('e-old','s1','g4','OldArchive',{old_30d},100.0,0.0);"
                ))
                .unwrap();
        }

        {
            let conn = open(&path).unwrap();
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(episodes)")
                .unwrap()
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            assert!(cols.iter().any(|c| c == "completed"));

            assert!(get_episode(&conn, "e-done").unwrap().unwrap().completed);
            assert!(!get_episode(&conn, "e-mid").unwrap().unwrap().completed);
            assert!(!get_episode(&conn, "e-null").unwrap().unwrap().completed);
            assert!(!get_episode(&conn, "e-old").unwrap().unwrap().completed);
            // 仅统计近 7 天内未看（e-mid, e-null），30 天前归档 e-old 不算进新更提醒
            assert_eq!(list_shows(&conn).unwrap()[0].unplayed, 2);

            let e_null = set_completed(&conn, "e-null", true).unwrap().unwrap();
            assert!(e_null.completed);
            assert_eq!(list_shows(&conn).unwrap()[0].unplayed, 1);

            let e_done_reset = set_completed(&conn, "e-done", false).unwrap().unwrap();
            assert!(!e_done_reset.completed);
            assert_eq!(e_done_reset.progress, 0.0);
            assert_eq!(list_shows(&conn).unwrap()[0].unplayed, 2);

            assert!(set_progress(&conn, "e-mid", 98.0).unwrap());
            assert!(get_episode(&conn, "e-mid").unwrap().unwrap().completed);
            assert_eq!(list_shows(&conn).unwrap()[0].unplayed, 1);

            // 一键标为已看清掉全部剩余未看（e-done 与 e-old）
            assert_eq!(mark_show_completed(&conn, "s1").unwrap(), 2);
            assert_eq!(list_shows(&conn).unwrap()[0].unplayed, 0);
            assert!(get_episode(&conn, "e-old").unwrap().unwrap().completed);
        }

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
