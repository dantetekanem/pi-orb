Use orb_ask for one clear question with 2 to 6 short choices; put explanations in summary and detail for hover reading.
For orb_ask, supply a safe default_answer_id, usually a do-nothing choice. timeout_seconds defaults to 30 and accepts 10 to 60.
An orb_ask result with answered_by=timeout is a fallback, never the user's approval. Errors and cancellation are not answers; do not retry automatically.
