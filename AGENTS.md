<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Captions are drawn by one canvas function (src/lib/captions.ts) shared by preview and export, so the downloaded video matches the preview exactly.
- Word timings come from a Gemini audio model via a server function (dedicated transcription endpoint has no timestamps); video export happens in the browser with MediaRecorder.
