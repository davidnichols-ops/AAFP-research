//! Research Agent: searches the web, browses the top result, and prints
//! a structured summary.
//!
//! Demonstrates the AAFP perception layer chaining multiple capabilities:
//!   1. Search the web via DuckDuckGo (free, no API key)
//!   2. Browse the top result via Firecrawl (requires FIRECRAWL_API_KEY)
//!   3. Print the structured content sections
//!
//! Usage:
//!   cargo run --package research-agent -- "your search query"
//!
//! Environment:
//!   FIRECRAWL_API_KEY — required for the browse step
//!   AAFP_PYTHON — optional, Python path for PDF reading (not used here)

use aafp_perception::{
    BrowseProvider, BrowseRequest, DuckDuckGoSearchProvider, FirecrawlBrowseProvider,
    SearchProvider, SearchRequest,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();

    let query = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "rust programming language".to_string());

    println!("=== AAFP Research Agent ===");
    println!("Query: \"{query}\"");
    println!();

    // Step 1: Search the web.
    println!("→ Searching DuckDuckGo...");
    let search_provider = DuckDuckGoSearchProvider::new()?;
    let search_req = SearchRequest {
        query: query.clone(),
        num_results: 5,
        sources: Vec::new(),
        time_range: None,
        fetch_content: false,
    };
    let search_resp = search_provider.search(&search_req).await?;

    if search_resp.results.is_empty() {
        println!("No results found.");
        return Ok(());
    }

    println!("Found {} results:", search_resp.results.len());
    for (i, result) in search_resp.results.iter().enumerate() {
        println!("  [{}] {} — {}", i + 1, result.title, result.url);
    }
    println!();

    // Step 2: Browse the top result.
    let top_result = &search_resp.results[0];
    println!("→ Browsing top result: {}", top_result.url);

    let browse_provider = match FirecrawlBrowseProvider::from_env(Default::default()) {
        Ok(p) => p,
        Err(e) => {
            println!("Note: Firecrawl not configured ({e})");
            println!("Set FIRECRAWL_API_KEY in .env to enable web browsing.");
            println!();
            println!("Search results are still available above.");
            return Ok(());
        }
    };

    let browse_req = BrowseRequest::new(&top_result.url);
    let content = browse_provider.browse(&browse_req).await?;

    // Step 3: Print structured content.
    println!();
    println!("═══ Content Summary ═══");
    println!("URL:   {}", content.url);
    println!("Title: {}", content.title);
    if let Some(lang) = &content.metadata.language {
        println!("Lang:  {lang}");
    }
    println!();

    println!("Sections ({}):", content.sections.len());
    for section in &content.sections {
        let indent = "  ".repeat(section.level as usize);
        println!("{indent}## {}", section.title);
        // Show first 300 chars of each section.
        let preview: String = section.content.chars().take(300).collect();
        if !preview.is_empty() {
            println!("{indent}   {preview}");
            if section.content.len() > 300 {
                println!("{indent}   ...");
            }
        }
        println!();
    }

    if !content.links.is_empty() {
        println!("Links ({}):", content.links.len());
        for link in content.links.iter().take(10) {
            let marker = if link.internal { "↩" } else { "→" };
            println!("  {marker} {} — {}", link.text, link.url);
        }
        if content.links.len() > 10 {
            println!("  ... and {} more", content.links.len() - 10);
        }
    }

    println!();
    println!("✓ Research complete: searched → browsed → summarized");

    Ok(())
}
