defmodule DojoWeb.FractalLive do
  @moduledoc """
  Fractal Challenge: a six-mission course inside Dojo, from finishing a
  half-drawn square to a snowflake fractal (square, triangle, hexagon,
  circle, spiral, snowflake).

  Ported from github.com/minka-iyer/fractal-challenge. That demo had its own
  editor and interpreter; here the editor is Dojo's CM6 PaperLang editor, the
  drawing is Dojo's turtle, and the check runs Dojo's own parser and executor
  (assets/js/fractal/check.js), so students learn real Dojo code.

  Course content lives in priv/fractal/levels.json, shared with the browser.
  The server owns the course flow: unlocking, hints, the quiz and xp. The
  browser hook (assets/js/hooks/fractal.js) owns the editor, the turtle and
  the shape check, and reports each run here. Progress is kept in the
  student's browser (localStorage), not on the server.
  """
  use DojoWeb, :live_shell

  import DojoWeb.SVGComponents, only: [manual: 1]

  @levels_path Path.join([__DIR__, "..", "..", "..", "priv", "fractal", "levels.json"])
               |> Path.expand()
  @external_resource @levels_path
  @course @levels_path |> File.read!() |> Jason.decode!()
  @levels @course["levels"]
  @commands @course["commands"]
  @count length(@levels)

  # Course pacing, as in the original demo.
  @hint_after_ms 60_000
  @hint_after_fails 2
  @fail_cooldown_ms 12_000
  @xp_level 100
  @xp_quiz 50
  @xp_run 3
  @xp_cmd 2
  @xp_small_cap 30
  @dojo_url "https://dojo.paperland.sg/shell"

  def levels, do: @levels

  @impl true
  def mount(_params, _session, socket) do
    socket =
      assign(socket,
        page_title: "Fractal Challenge",
        levels: @levels,
        commands: @commands,
        count: @count,
        dojo_url: @dojo_url,
        locale: "en",
        done: 0,
        xp: 0
      )

    {:ok, open_level(socket, 0)}
  end

  # ---------------------------------------------------------------- events

  @impl true
  def handle_event("restore", params, socket) do
    done = params |> Map.get("done") |> clamp_int(0, @count)
    xp = params |> Map.get("xp") |> clamp_int(0, 1_000_000)
    socket = assign(socket, done: done, xp: xp)
    {:noreply, open_level(socket, min(done, @count - 1))}
  end

  def handle_event("open", %{"level" => level}, socket) do
    i = clamp_int(level, 0, @count - 1)

    if i <= socket.assigns.done do
      {:noreply, open_level(socket, i)}
    else
      prev = Enum.at(@levels, i - 1)
      {:noreply, put_toast(socket, "Finish #{prev["tab"]} first.")}
    end
  end

  def handle_event("run", %{"pass" => true}, %{assigns: %{phase: :play, shown: false}} = socket) do
    a = socket.assigns
    first = a.cur == a.done

    socket =
      socket
      |> assign(phase: :solved, shown: true, first: first)
      |> then(fn s ->
        if first, do: s |> assign(done: a.done + 1) |> gain(@xp_level), else: s
      end)
      |> save()

    {:noreply, socket}
  end

  def handle_event("run", %{"pass" => false} = params, %{assigns: %{phase: :play}} = socket) do
    now = System.monotonic_time(:millisecond)
    a = socket.assigns
    fresh = params["fresh"] == true

    socket =
      if fresh and now - a.last_fail_at > @fail_cooldown_ms do
        socket |> assign(fails: a.fails + 1, last_fail_at: now) |> refresh_hint()
      else
        socket
      end

    socket = if fresh and params["drew"] == true, do: small_gain(socket, @xp_run), else: socket
    {:noreply, socket}
  end

  def handle_event("run", %{"pass" => true, "fresh" => true}, socket) do
    {:noreply, small_gain(socket, @xp_run)}
  end

  def handle_event("run", _params, socket), do: {:noreply, socket}

  # The hook reports each Command Deck card the student uses (the deck itself
  # writes into the editor, exactly as in the shell). First use earns a little xp.
  def handle_event("deck", %{"cmd" => cmd}, socket)
      when is_binary(cmd) and byte_size(cmd) <= 16 do
    socket =
      if MapSet.member?(socket.assigns.used_cmds, cmd) do
        socket
      else
        socket |> update(:used_cmds, &MapSet.put(&1, cmd)) |> small_gain(@xp_cmd)
      end

    {:noreply, socket}
  end

  def handle_event("hint", _params, socket) do
    level = current(socket)
    step = min(socket.assigns.hint_step + 1, length(level["hints"]))
    {:noreply, assign(socket, hint_step: step)}
  end

  def handle_event("continue", _params, socket) do
    if socket.assigns.first do
      {:noreply, assign(socket, phase: :quiz, wrong: MapSet.new(), answered: false)}
    else
      {:noreply, next_level(socket)}
    end
  end

  def handle_event("keep-playing", _params, socket) do
    {:noreply, assign(socket, phase: :play)}
  end

  def handle_event("answer", %{"i" => i}, %{assigns: %{phase: :quiz, answered: false}} = socket) do
    quiz = current(socket)["quiz"]
    i = clamp_int(i, 0, length(quiz["options"]) - 1)

    cond do
      i != quiz["correct"] ->
        {:noreply, update(socket, :wrong, &MapSet.put(&1, i))}

      MapSet.size(socket.assigns.wrong) == 0 ->
        {:noreply, socket |> assign(answered: true, bonus: true) |> gain(@xp_quiz) |> save()}

      true ->
        {:noreply, assign(socket, answered: true, bonus: false)}
    end
  end

  def handle_event("next", _params, socket), do: {:noreply, next_level(socket)}

  def handle_event("restart", _params, socket) do
    {:noreply,
     socket
     |> assign(done: 0, xp: 0)
     |> save()
     |> push_event("clear-code", %{})
     |> open_level(0)}
  end

  def handle_event(_event, _params, socket), do: {:noreply, socket}

  @impl true
  def handle_info({:hint_ready, token}, socket) do
    if token == socket.assigns.level_token do
      {:noreply, socket |> assign(timer_up: true) |> refresh_hint()}
    else
      {:noreply, socket}
    end
  end

  # --------------------------------------------------------------- helpers

  defp open_level(socket, i) do
    token = make_ref()
    if connected?(socket), do: Process.send_after(self(), {:hint_ready, token}, @hint_after_ms)
    level = Enum.at(@levels, i)

    socket
    |> assign(
      cur: i,
      phase: :play,
      shown: false,
      first: false,
      fails: 0,
      last_fail_at: -@fail_cooldown_ms,
      timer_up: false,
      hint_ready: false,
      hint_step: 0,
      small_xp: 0,
      used_cmds: MapSet.new(),
      wrong: MapSet.new(),
      answered: false,
      bonus: false,
      level_token: token
    )
    |> push_event("level", %{
      index: i,
      solution: level["solution"],
      tolerance: level["tolerance"],
      starter: level["starter"] || "",
      placeholder: level["try"]
    })
  end

  defp next_level(socket) do
    if socket.assigns.cur < @count - 1 do
      open_level(socket, socket.assigns.cur + 1)
    else
      assign(socket, phase: :finished)
    end
  end

  defp refresh_hint(socket) do
    a = socket.assigns
    assign(socket, hint_ready: a.timer_up or a.fails >= @hint_after_fails)
  end

  defp current(socket), do: Enum.at(@levels, socket.assigns.cur)

  # Running code and trying commands earn a little xp, capped per level.
  defp small_gain(socket, n) do
    if socket.assigns.small_xp >= @xp_small_cap do
      socket
    else
      socket |> update(:small_xp, &(&1 + n)) |> gain(n) |> save()
    end
  end

  defp gain(socket, n) do
    before = level_of(socket.assigns.xp)
    socket = update(socket, :xp, &(&1 + n)) |> push_event("xp", %{n: n})
    after_ = level_of(socket.assigns.xp)
    if after_ > before, do: put_toast(socket, "Level #{after_} reached."), else: socket
  end

  defp save(socket) do
    push_event(socket, "save", %{done: socket.assigns.done, xp: socket.assigns.xp})
  end

  defp put_toast(socket, msg), do: push_event(socket, "toast", %{text: msg})

  @doc false
  # The right answer is always first in levels.json; show the options in a
  # different order on each mission so it is not always the top one.
  def quiz_order(options, cur) do
    indexed = Enum.with_index(options)
    {a, b} = Enum.split(indexed, rem(cur * 2, length(indexed)))
    b ++ a
  end

  @doc false
  # xp needed to reach player level l: 0, 100, 300, 600, ...
  def xp_for(l), do: div(50 * l * (l - 1), 1)

  @doc false
  def level_of(xp), do: level_of(xp, 1)
  defp level_of(xp, l), do: if(xp >= xp_for(l + 1), do: level_of(xp, l + 1), else: l)

  defp clamp_int(v, lo, hi) when is_integer(v), do: v |> max(lo) |> min(hi)

  defp clamp_int(v, lo, hi) when is_binary(v) do
    case Integer.parse(v) do
      {n, _} -> clamp_int(n, lo, hi)
      :error -> lo
    end
  end

  defp clamp_int(_v, lo, _hi), do: lo

  # Commands a mission introduces, shown on the mission card.
  def new_commands(level) do
    for %{"c" => c} = d <- level["deck"], d["new"], do: c
  end

  attr :primary, :boolean, default: false
  attr :rest, :global
  slot :inner_block, required: true

  # A text button in the Dojo shell's style (font-mono, accent border).
  def fx_button(assigns) do
    ~H"""
    <button
      type="button"
      class={[
        "px-3 py-1 font-mono text-sm border-1 rounded-sm transition-all duration-300 cursor-pointer hover:scale-105 touch-manipulation",
        @primary && "border-primary text-primary hover:bg-primary/20",
        !@primary && "border-accent text-primary-content hover:bg-accent/50"
      ]}
      {@rest}
    >
      {render_slot(@inner_block)}
    </button>
    """
  end

  # Text with `code` spans, for hints and goals. Phoenix escapes each part.
  def rich(assigns) do
    parts = assigns.text |> String.split("`") |> Enum.with_index()
    assigns = assign(assigns, :parts, parts)

    ~H"""
    <span phx-no-format><%= for {part, i} <- @parts do %><%= if rem(i, 2) == 1 do %><code class="text-lint-commands">{part}</code><% else %>{part}<% end %><% end %></span>
    """
  end
end
