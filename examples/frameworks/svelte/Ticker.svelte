<script>
  import { onMount } from 'svelte';
  import { TICKING } from '../shared/app-spec.js';
  let n = $state(0);
  onMount(() => {
    if (!TICKING) return;
    const t = setInterval(() => n++, 500);
    return () => clearInterval(t);
  });
</script>

<div class="tick">tick: {n}</div>
