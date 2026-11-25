defmodule DojoWeb.FractalLiveTest do
  use DojoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  alias DojoWeb.FractalLive

  test "opens on mission 1 with later missions locked", %{conn: conn} do
    {:ok, view, html} = live(conn, "/fractal")
    assert html =~ "Draw a triangle"
    assert has_element?(view, ~s|.fx-tab[data-state="locked"]|, "Hexagon")

    html = view |> element(~s|.fx-tab[phx-value-level="1"]|) |> render_click()
    refute html =~ "Draw a hexagon"
    assert_push_event(view, "toast", %{text: "Finish Triangle first."})
  end

  test "solving, then the quiz, unlocks the next mission and earns xp", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")

    html = render_hook(view, "run", %{"pass" => true, "drew" => true, "fresh" => true})
    assert html =~ "You <em>did</em> it"
    assert_push_event(view, "save", %{done: 1, xp: 100})

    html = view |> element("button", "Continue") |> render_click()
    assert html =~ "Why rt 120 and not rt 60?"

    html = view |> element(~s|.fx-opt[phx-value-i="0"]|) |> render_click()
    assert html =~ "(+50 xp)"
    assert html =~ "150 xp"

    html = view |> element("button", "Next: Hexagon") |> render_click()
    assert html =~ "Draw a hexagon"
    assert_push_event(view, "level", %{index: 1})
  end

  test "a wrong first answer loses the quiz bonus", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    render_hook(view, "run", %{"pass" => true, "drew" => true, "fresh" => true})
    view |> element("button", "Continue") |> render_click()

    html = view |> element(~s|.fx-opt[phx-value-i="1"]|) |> render_click()
    assert html =~ "Not quite. Try another one."

    html = view |> element(~s|.fx-opt[phx-value-i="0"]|) |> render_click()
    refute html =~ "(+50 xp)"
    assert html =~ "100 xp"
  end

  test "hints appear after two fresh failed runs", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    refute render(view) =~ "Stuck? Get a hint"

    render_hook(view, "run", %{"pass" => false, "drew" => true, "fresh" => true})
    # The second fail inside the 12 s cooldown does not count...
    refute render_hook(view, "run", %{"pass" => false, "drew" => true, "fresh" => true}) =~
             "Stuck?"

    # ...but the 60 s timer still opens hints.
    send(view.pid, {:hint_ready, :sys.get_state(view.pid).socket.assigns.level_token})
    html = view |> element("button", "Stuck? Get a hint") |> render_click()
    assert html =~ "Hint 1 of 3"
    assert html =~ "<code>fw 100</code>"
  end

  test "restore clamps progress from the browser", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    html = render_hook(view, "restore", %{"done" => 99, "xp" => -5})
    assert html =~ "Draw a snowflake fractal"
    assert html =~ "0 xp"
    refute has_element?(view, ~s|.fx-tab[data-state="locked"]|)
  end

  test "the deck inserts the command and gives xp once", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/fractal")
    view |> element(~s|.fx-cmd[phx-value-cmd="fw"]|) |> render_click()
    assert_push_event(view, "insert", %{text: "fw 50"})
    assert render(view) =~ "2 xp"
    view |> element(~s|.fx-cmd[phx-value-cmd="fw"]|) |> render_click()
    assert render(view) =~ "2 xp"
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
