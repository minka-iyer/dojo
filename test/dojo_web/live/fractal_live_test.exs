defmodule DojoWeb.FractalLiveTest do
  use DojoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  alias DojoWeb.FractalLive

  test "opens on the square mission with later missions locked", %{conn: conn} do
    {:ok, view, html} = live(conn, "/fractal")
    assert html =~ "Complete the square"
    assert has_element?(view, ~s|#fx-tabs button[data-locked]|, "Triangle")

    html = view |> element(~s|#fx-tabs button[phx-value-level="1"]|) |> render_click()
    refute html =~ "Draw a triangle"
    assert_push_event(view, "toast", %{text: "Finish Square first."})
  end

  test "solving, then the quiz, unlocks the next mission and earns xp", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")

    html = render_hook(view, "run", %{"pass" => true, "drew" => true, "fresh" => true})
    assert html =~ "You did it"
    assert has_element?(view, "#commanddeck")
    assert_push_event(view, "save", %{done: 1, xp: 100})

    html = view |> element("button", "continue") |> render_click()
    assert html =~ "Why does every corner of the square use rt 90?"

    html = view |> element(~s|.fx-opt[phx-value-i="0"]|) |> render_click()
    assert html =~ "(+50 xp)"
    assert html =~ "150xp"

    html = view |> element("button", "next: triangle") |> render_click()
    assert html =~ "Draw a triangle"
    assert_push_event(view, "level", %{index: 1})
  end

  test "a wrong first answer loses the quiz bonus", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    render_hook(view, "run", %{"pass" => true, "drew" => true, "fresh" => true})
    view |> element("button", "continue") |> render_click()

    html = view |> element(~s|.fx-opt[phx-value-i="1"]|) |> render_click()
    assert html =~ "Not quite. Try another one."

    html = view |> element(~s|.fx-opt[phx-value-i="0"]|) |> render_click()
    refute html =~ "(+50 xp)"
    assert html =~ "100xp"
  end

  test "hints appear after two fresh failed runs", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    refute render(view) =~ "stuck? get a hint"

    render_hook(view, "run", %{"pass" => false, "drew" => true, "fresh" => true})
    # The second fail inside the 12 s cooldown does not count...
    refute render_hook(view, "run", %{"pass" => false, "drew" => true, "fresh" => true}) =~
             "stuck?"

    # ...but the 60 s timer still opens hints.
    send(view.pid, {:hint_ready, :sys.get_state(view.pid).socket.assigns.level_token})
    html = view |> element("button", "stuck? get a hint") |> render_click()
    assert html =~ "hint 1/3"
    assert html =~ ~s|<code class="text-lint-commands">fw 100</code>|
  end

  test "the square mission opens with its half-drawn starter code", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    render_hook(view, "restore", %{"done" => 0, "xp" => 0})
    assert_push_event(view, "level", %{index: 0, starter: "fw 100\nrt 90\nfw 100\nrt 90\n"})
  end

  test "restore clamps progress from the browser", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    html = render_hook(view, "restore", %{"done" => 99, "xp" => -5})
    assert html =~ "Draw a snowflake fractal"
    assert html =~ "0xp"
    refute has_element?(view, ~s|#fx-tabs button[data-locked]|)
  end

  test "using a Command Deck card gives xp once", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    assert render_hook(view, "deck", %{"cmd" => "fw"}) =~ "2xp"
    assert render_hook(view, "deck", %{"cmd" => "fw"}) =~ "2xp"
    assert render_hook(view, "deck", %{"cmd" => "rt"}) =~ "4xp"
  end

  test "player levels follow the original xp curve" do
    assert Enum.map([0, 99, 100, 299, 300, 600], &FractalLive.level_of/1) == [1, 1, 2, 2, 3, 4]
  end

  test "course copy has no em dashes" do
    for lv <- FractalLive.levels(), text <- [lv["goal"], lv["title"] | lv["hints"]] do
      refute text =~ "\u2014"
    end
  end
end
