import QBRecordCore
import SwiftUI

@main
struct QBRecordApp: App {
  var body: some Scene { WindowGroup { RecordHomeView() } }
}

struct RecordHomeView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var attemptsID = ""
  @State private var questionsID = ""
  @State private var reviewParentID = ""
  @State private var token = ""
  @State private var status: RecordStatus?
  @State private var configured = false
  @State private var busy = false
  @State private var message = ""
  @State private var operation: Task<Void, Never>?

  var body: some View {
    NavigationStack {
      Form {
        Section("保存状況") {
          if let status {
            LabeledContent("端末保存済み", value: "\(status.saved) 件")
            LabeledContent("Notion送信待ち", value: "\(status.pending) 件")
            LabeledContent("Notion確認済み", value: "\(status.confirmed) 件")
            if status.blocked > 0 { LabeledContent("確認が必要", value: "\(status.blocked) 件") }
            Text("Safari内だけに保存された転送待ちは、この件数に含まれません。転送待ちの場合はSafariのQBを開いてください。").font(.footnote)
          } else {
            Text("保存状況を確認中です")
          }
          Button("送信を再開して確認") { beginRefresh() }
            .disabled(busy || !configured)
        }
        Section {
          Text("SafariでQBを解くと自動で記録します。Safariの拡張設定でQB記録を有効にし、qb.medilink-study.com へのアクセスを許可してください。")
          Text("端末に保存した後でNotionへ送信します。アプリを閉じている間の即時送信は保証されません。アプリ側に保存済みの記録は、QBかこのアプリを開くと送信を再開します。")
          Text("端末保存が完了する前にタブやアプリを終了すると、記録できない場合があります。問題本文や解説は保存しません。")
        } header: {
          Text("Safariでの利用")
        }
        Section {
          TextField("解答ログのデータソースID", text: $attemptsID).disabled(configured)
          TextField("問題マスターのデータソースID", text: $questionsID).disabled(configured)
          TextField("復習計画の親ページID（任意）", text: $reviewParentID)
          Text("データソースIDはNotionの表を識別する番号です。ページIDとは異なります。親ページを設定しない場合、セットの由来は未確認として保存します。")
            .font(.footnote)
        } header: {
          Text("Notionの保存先")
        }
        .disabled(busy)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        Section {
          SecureField(configured ? "接続キーを更新する場合だけ入力" : "Notion接続キー", text: $token)
            .textContentType(.password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button(configured ? "接続設定を確認して更新" : "接続を確認して保存") { beginSave() }
            .disabled(busy || (!configured && token.isEmpty))
          Text("キーはこの端末のKeychain（秘密情報の専用保存領域）に保存します。別の端末では接続設定が必要です。チャットには貼らないでください。接続確認では学習記録を作成しません。")
            .font(.footnote)
        } header: {
          Text("接続設定")
        }
        if !message.isEmpty { Section { Text(message).font(.footnote).textSelection(.enabled) } }
        Section {
          Text("アプリを削除すると、Notionへ未送信の記録も失われます。保存状況を確認してから削除してください。")
            .font(.footnote)
          Text("試作版 0.1.0 · iPhone / iPad")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
      .navigationTitle("QB記録")
      .overlay {
        if busy {
          ProgressView().padding().background(
            .regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
      }
      .task { beginRefresh() }
      .onChange(of: scenePhase) { phase in
        if phase == .active { beginRefresh() } else { operation?.cancel() }
        if phase == .background { token = "" }
      }
    }
  }

  @MainActor private func beginRefresh() {
    let previous = operation
    previous?.cancel()
    operation = Task {
      await previous?.value
      guard !Task.isCancelled else { return }
      await refresh(sync: true)
    }
  }

  @MainActor private func beginSave() {
    let previous = operation
    previous?.cancel()
    operation = Task {
      await previous?.value
      guard !Task.isCancelled else { return }
      await save()
    }
  }

  @MainActor private func refresh(sync: Bool) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let environment = try AppEnvironment()
      if let settings = try environment.settings() {
        attemptsID = settings.attemptsDataSourceID
        questionsID = settings.questionsDataSourceID
        reviewParentID = settings.reviewParentPageID ?? ""
        configured = true
      }
      status = try environment.store.status()
      if sync && configured {
        let report = try await environment.sync(foreground: true)
        status = try environment.store.status()
        message = report.code.map { "同期の確認が必要です: \($0)" } ?? "保存状況を確認しました。"
      }
    } catch { message = "処理を完了できませんでした: \(AppEnvironment.safeCode(error))" }
  }

  @MainActor private func save() async {
    guard !busy else { return }
    busy = true
    do {
      let environment = try AppEnvironment()
      let settings = try AppEnvironment.Settings(
        attempts: attemptsID, questions: questionsID, reviewParent: reviewParentID)
      try await environment.save(settings: settings, token: token)
      token = ""
      configured = true
      message = "接続先の構造を確認し、設定を保存しました。"
      if settings.reviewParentPageID != nil && !Task.isCancelled {
        do {
          let report = try await environment.warmReviewCatalog()
          if let code = report.code { message = "設定は保存済みです。復習情報の照合は後で再開します: \(code)" }
        } catch { message = "設定は保存済みです。復習情報の照合は後で再開します。" }
      }
    } catch { message = "設定を保存できませんでした: \(AppEnvironment.safeCode(error))" }
    busy = false
    if !Task.isCancelled { await refresh(sync: false) }
  }
}
