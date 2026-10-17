mod content;
mod layout;
mod routes;

use std::error::Error;
use std::path::Path;
use std::process::ExitCode;

use maudit::content::ContentSources;
use maudit::{BuildOptions, PrefetchOptions, PrefetchStrategy, coronate};

use content::{Lang, Site, load_dir};

/// Run from apps/docs: content, assets and static paths are relative to it.
fn main() -> ExitCode {
    match build() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

fn build() -> Result<(), Box<dyn Error>> {
    let mut pages = Vec::new();
    for lang in Lang::ALL {
        pages.extend(load_dir(lang, &Path::new("content").join(lang.code()))?);
    }
    let site = Site::new(pages)?;
    println!("docs routes: {}", routes::route_list(&site).len());
    routes::install(site);
    coronate(
        maudit::routes![
            routes::DocsRootEn,
            routes::DocsRootId,
            routes::CategoryEn,
            routes::CategoryId,
            routes::DocEn,
            routes::DocId
        ],
        ContentSources::new(vec![]),
        BuildOptions {
            // Pages are read by hand, outside maudit's tracked content sources,
            // so an incremental build would not notice an edited page.
            incremental: false,
            prefetch: PrefetchOptions {
                strategy: PrefetchStrategy::None,
                ..Default::default()
            },
            ..Default::default()
        },
    )?;
    Ok(())
}
