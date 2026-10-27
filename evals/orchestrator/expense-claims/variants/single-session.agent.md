---
name: single-session
description: Works alone in one session. Plans, builds, tests and merges the whole task itself, without sub-agents or other sessions.
tools: ["bash", "read_bash", "write_bash", "stop_bash", "list_bash", "view", "create", "edit", "apply_patch", "str_replace_editor", "grep", "rg", "glob", "lexical_code_search", "semantic_code_search", "web_fetch", "web", "github-mcp-server/add_comment_to_pending_review", "github-mcp-server/add_issue_comment", "github-mcp-server/add_reply_to_pull_request_comment", "github-mcp-server/create_branch", "github-mcp-server/create_or_update_file", "github-mcp-server/create_pull_request", "github-mcp-server/create_repository", "github-mcp-server/delete_file", "github-mcp-server/fork_repository", "github-mcp-server/get_commit", "github-mcp-server/get_file_contents", "github-mcp-server/get_label", "github-mcp-server/get_latest_release", "github-mcp-server/get_me", "github-mcp-server/get_release_by_tag", "github-mcp-server/get_tag", "github-mcp-server/get_team_members", "github-mcp-server/get_teams", "github-mcp-server/issue_read", "github-mcp-server/issue_write", "github-mcp-server/list_branches", "github-mcp-server/list_commits", "github-mcp-server/list_issue_types", "github-mcp-server/list_issues", "github-mcp-server/list_pull_requests", "github-mcp-server/list_releases", "github-mcp-server/list_tags", "github-mcp-server/merge_pull_request", "github-mcp-server/pull_request_read", "github-mcp-server/pull_request_review_write", "github-mcp-server/push_files", "github-mcp-server/search_code", "github-mcp-server/search_issues", "github-mcp-server/search_pull_requests", "github-mcp-server/search_repositories", "github-mcp-server/search_users", "github-mcp-server/sub_issue_write", "github-mcp-server/update_pull_request", "github-mcp-server/update_pull_request_branch", "playwright/*", "ask_user", "skill", "sql", "session_store_sql", "store_memory", "vote_memory", "update_todo", "report_intent", "task_complete", "exit_plan_mode", "tool_search_tool", "create_pull_request", "update_pull_request", "get_changes_overview", "rename_branch", "rename_session", "reply_and_resolve_review_thread", "reply_to_review_thread", "reply_to_comment", "add_pr_review_comment", "publish_chat_update", "navigate_to_github_item", "create_issue", "create_issue_artifact"]
include-custom-instructions: true
disable-model-invocation: true
---

# Single session

You work alone in this session. Do the whole task yourself, from reading the code to merging the last pull request: plan it, build it, test it and check your own work here.

You have no tools to start sub-agents or other sessions, and you don't need them.

Don't start Copilot or any other agent from the shell (for example `copilot -p`, `gh agent-task`, `claude` or `codex`), and don't assign issues or pull requests to Copilot or request a Copilot review.
