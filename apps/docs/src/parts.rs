//! Continuation parts of a page: `x.2.md`, `x.3.md`, ... go on where `x.md`
//! stops, so a translated page too long for one file under the size gate can
//! be split at a heading, preferably where its English source is. docs-gen checks the
//! same rules (scripts/lib/docs-gen-id.mjs).

use std::collections::HashMap;

use crate::content::{ContentError, DocPage, Lang};

/// The base file a continuation part belongs to and its number: `x.2.md` is
/// part 2 of `x.md`. A page too long for one file under the size gate goes on
/// in `x.2.md`, `x.3.md`, ..., without frontmatter, the way the English source
/// is split into `docs/guide/x-1.md`, `x-2.md`. Part numbers start at 2.
pub fn part_of(name: &str) -> Option<(String, u32)> {
    let stem = name.strip_suffix(".md")?;
    let (base, n) = stem.rsplit_once('.')?;
    if base.is_empty() || n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((format!("{base}.md"), n.parse().ok()?))
}

/// Parses each page file and appends its continuation parts in order, joined
/// the way docs-gen joins English parts: trailing blank lines dropped from each
/// piece, one blank line between pieces.
pub fn assemble(lang: Lang, files: Vec<(String, String)>) -> Result<Vec<DocPage>, ContentError> {
    let part_err = |file: &str, message: String| ContentError::Part {
        lang,
        file: file.to_string(),
        message,
    };
    let mut parts: HashMap<String, Vec<(u32, String, String)>> = HashMap::new();
    let mut bases = Vec::new();
    for (name, src) in files {
        match part_of(&name) {
            Some((base, n)) => parts.entry(base).or_default().push((n, name, src)),
            None => bases.push((name, src)),
        }
    }
    let mut out = Vec::new();
    for (name, src) in bases {
        let mut page = DocPage::parse(lang, &name, &src)?;
        if let Some(mut own) = parts.remove(&name) {
            own.sort_by_key(|(n, _, _)| *n);
            let mut body = page.body.trim_end().to_string();
            for (i, (n, part, text)) in own.into_iter().enumerate() {
                let want = i as u32 + 2;
                if n != want {
                    return Err(part_err(&part, format!("is part {n}, but part {want} of {name} is missing")));
                }
                if text.starts_with("---") {
                    return Err(part_err(&part, "a continuation part has no frontmatter; it belongs to the base file".into()));
                }
                body.push_str("\n\n");
                body.push_str(text.trim_end());
            }
            body.push('\n');
            page.body = body;
        }
        out.push(page);
    }
    if let Some(name) = parts.into_values().flatten().map(|(_, name, _)| name).min() {
        return Err(part_err(&name, "has no base page to continue".into()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::fixtures::source;

    #[test]
    fn part_of_reads_a_continuation_name_and_nothing_else() {
        assert_eq!(part_of("tooling-zeta.2.md"), Some(("tooling-zeta.md".into(), 2)));
        assert_eq!(part_of("tooling-zeta.12.md"), Some(("tooling-zeta.md".into(), 12)));
        assert_eq!(part_of("tooling-zeta.md"), None);
        assert_eq!(part_of("tooling-zeta-2.md"), None);
        assert_eq!(part_of("tooling-zeta.x.md"), None);
        assert_eq!(part_of(".2.md"), None);
    }

    #[test]
    fn continuation_parts_join_in_number_order_like_the_english_parts() {
        let base = source("tooling", "zeta", 1, "Zeta");
        let files = vec![
            ("tooling-zeta.3.md".to_string(), "## Third\n\nc\n\n\n".to_string()),
            ("tooling-zeta.md".to_string(), base),
            ("tooling-zeta.2.md".to_string(), "## Second\n\nb\n".to_string()),
        ];
        let pages = assemble(Lang::Id, files).unwrap();
        assert_eq!(pages.len(), 1);
        assert!(
            pages[0].body.ends_with("\n\n## Second\n\nb\n\n## Third\n\nc\n"),
            "{:?}",
            pages[0].body
        );
        assert_eq!(pages[0].file, "tooling-zeta.md");
    }

    #[test]
    fn a_part_without_its_base_page_is_an_error_naming_it() {
        let files = vec![("tooling-zeta.2.md".to_string(), "## Second\n".to_string())];
        let err = assemble(Lang::Id, files).unwrap_err().to_string();
        assert_eq!(err, "id/tooling-zeta.2.md: has no base page to continue");
    }

    #[test]
    fn a_gap_in_the_part_numbers_is_an_error_naming_the_missing_part() {
        let files = vec![
            ("tooling-zeta.md".to_string(), source("tooling", "zeta", 1, "Zeta")),
            ("tooling-zeta.3.md".to_string(), "## Third\n".to_string()),
        ];
        let err = assemble(Lang::Id, files).unwrap_err().to_string();
        assert_eq!(err, "id/tooling-zeta.3.md: is part 3, but part 2 of tooling-zeta.md is missing");
    }

    #[test]
    fn the_real_indonesian_pages_load_with_their_parts() {
        // cargo runs tests from apps/docs, the same directory a build reads content from.
        let pages = crate::content::load_dir(Lang::Id, std::path::Path::new("content/id")).unwrap();
        let quick = pages.iter().find(|p| p.file == "getting-started-quick-start.md").unwrap();
        assert!(quick.body.contains("## Harness yang Didukung & Path Target"), "part 2 missing");
        assert!(quick.body.contains("## Agent Claude Code"), "part 4 missing");
        assert!(quick.body.contains("sprite-model-router"), "the part 4 paragraph is missing");
        assert!(pages.iter().all(|p| crate::parts::part_of(&p.file).is_none()), "a part loaded as a page");
    }

    #[test]
    fn a_part_with_frontmatter_is_an_error() {
        let files = vec![
            ("tooling-zeta.md".to_string(), source("tooling", "zeta", 1, "Zeta")),
            ("tooling-zeta.2.md".to_string(), source("tooling", "zeta", 1, "Zeta")),
        ];
        let err = assemble(Lang::Id, files).unwrap_err().to_string();
        assert!(err.starts_with("id/tooling-zeta.2.md: a continuation part has no frontmatter"), "{err}");
    }
}
